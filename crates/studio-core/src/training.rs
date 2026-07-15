// SPDX-License-Identifier: LGPL-3.0-or-later
//! Backend-neutral training-log parsing and process resource sampling.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::LazyLock;

use chrono::Utc;
use regex::Regex;
use sysinfo::{Pid, ProcessesToUpdate, System};
use tokio::process::Command;

use crate::{GpuResourceSample, TrainingMetricSample, TrainingResourceSample, TrainingSnapshot};

const MAX_METRIC_SAMPLES: usize = 2_000;
const MAX_RESOURCE_SAMPLES: usize = 600;

static STEP_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:batch|step)\s+(\d+)\s*:").expect("valid step expression")
});
static METRIC_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"([A-Za-z][A-Za-z0-9_./-]*)\s*=\s*([+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|nan|inf))",
    )
    .expect("valid metric expression")
});
static STEP_TIME_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bavg\s*=\s*([0-9.eE+-]+)\s*s/step").expect("valid step-time expression")
});
static ETA_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\beta\s*=\s*(?:(\d+)\s+days?,\s*)?(\d{1,2}):(\d{2}):(\d{2})")
        .expect("valid ETA expression")
});

/// Parse one DeePMD training log line into a dynamic metric sample.
#[must_use]
pub fn parse_training_line(line: &str) -> Option<TrainingMetricSample> {
    let step_match = STEP_PATTERN.captures(line)?;
    let whole_match = step_match.get(0)?;
    let step = step_match.get(1)?.as_str().parse::<u64>().ok()?;
    let metric_matches = METRIC_PATTERN.captures_iter(&line[whole_match.end()..]);
    let mut values = BTreeMap::new();
    let mut learning_rate = None;
    let mut first_metric_start = None;

    for captures in metric_matches {
        let matched = captures.get(0)?;
        first_metric_start.get_or_insert(matched.start());
        let mut key = captures.get(1)?.as_str().to_ascii_lowercase();
        let value = captures.get(2)?.as_str().parse::<f64>().ok()?;
        if !value.is_finite() {
            continue;
        }
        if key == "lr" || key == "learning_rate" {
            learning_rate = Some(value);
            continue;
        }
        if key == "train_loss" {
            key = "loss".into();
        }
        values.insert(key, value);
    }
    if values.is_empty() {
        return None;
    }

    let prefix_end = whole_match.end() + first_metric_start.unwrap_or(0);
    let prefix = line[whole_match.end()..prefix_end].trim_matches(|character: char| {
        character.is_whitespace() || character == ':' || character == ','
    });
    let (phase, task) = split_phase_and_task(prefix);
    Some(TrainingMetricSample {
        step,
        phase,
        task,
        values,
        learning_rate,
        timestamp: Utc::now(),
    })
}

fn split_phase_and_task(prefix: &str) -> (String, Option<String>) {
    let normalized = prefix.trim();
    if normalized.is_empty() || normalized.eq_ignore_ascii_case("trn") {
        return ("train".into(), None);
    }
    if normalized.eq_ignore_ascii_case("val") {
        return ("validation".into(), None);
    }
    for (suffix, phase) in [("_trn", "train"), ("_val", "validation")] {
        if let Some(task) = normalized.strip_suffix(suffix) {
            return (phase.into(), (!task.is_empty()).then(|| task.to_owned()));
        }
    }
    (normalized.to_ascii_lowercase(), None)
}

impl TrainingSnapshot {
    /// Update progress, ETA, and dynamic metric history from one output line.
    pub fn apply_log_line(&mut self, line: &str) -> bool {
        let mut changed = false;
        if let Some(sample) = parse_training_line(line) {
            self.current_step = self.current_step.max(sample.step);
            self.metrics.push(sample);
            trim_front(&mut self.metrics, MAX_METRIC_SAMPLES);
            changed = true;
        } else if let Some(captures) = STEP_PATTERN.captures(line)
            && let Some(step) = captures
                .get(1)
                .and_then(|value| value.as_str().parse::<u64>().ok())
        {
            self.current_step = self.current_step.max(step);
            changed = true;
        }
        if let Some(captures) = STEP_TIME_PATTERN.captures(line) {
            self.step_time_seconds = captures
                .get(1)
                .and_then(|value| value.as_str().parse::<f64>().ok());
            changed = true;
        }
        if let Some(captures) = ETA_PATTERN.captures(line) {
            let days = captures
                .get(1)
                .and_then(|value| value.as_str().parse::<u64>().ok())
                .unwrap_or(0);
            let hours = captures
                .get(2)
                .and_then(|value| value.as_str().parse::<u64>().ok());
            let minutes = captures
                .get(3)
                .and_then(|value| value.as_str().parse::<u64>().ok());
            let seconds = captures
                .get(4)
                .and_then(|value| value.as_str().parse::<u64>().ok());
            if let (Some(hours), Some(minutes), Some(seconds)) = (hours, minutes, seconds) {
                self.eta_seconds = Some(days * 86_400 + hours * 3_600 + minutes * 60 + seconds);
                changed = true;
            }
        }
        changed
    }

    /// Append one bounded resource sample.
    pub fn push_resource(&mut self, sample: TrainingResourceSample) {
        self.resources.push(sample);
        trim_front(&mut self.resources, MAX_RESOURCE_SAMPLES);
    }
}

fn trim_front<T>(values: &mut Vec<T>, maximum: usize) {
    if values.len() > maximum {
        values.drain(..values.len() - maximum);
    }
}

/// Stateful sampler for one training process tree.
pub struct ResourceSampler {
    system: System,
}

impl ResourceSampler {
    /// Create a sampler with the initial CPU counters required by sysinfo.
    #[must_use]
    pub fn new() -> Self {
        Self {
            system: System::new_all(),
        }
    }

    /// Capture normalized CPU, RAM, and available NVIDIA telemetry.
    pub async fn sample(&mut self, root_pid: u32) -> TrainingResourceSample {
        self.system.refresh_memory();
        self.system.refresh_processes(ProcessesToUpdate::All, true);
        let root = Pid::from_u32(root_pid);
        let processes = self.system.processes();
        let process_ids = descendant_processes(root, processes);
        let cpu_total = process_ids
            .iter()
            .filter_map(|pid| processes.get(pid))
            .map(sysinfo::Process::cpu_usage)
            .sum::<f32>();
        let logical_cores = self.system.cpus().len().max(1) as f32;
        let process_memory_bytes = process_ids
            .iter()
            .filter_map(|pid| processes.get(pid))
            .map(sysinfo::Process::memory)
            .sum();
        let system_memory_total_bytes = self.system.total_memory();
        let system_memory_used_bytes =
            system_memory_total_bytes.saturating_sub(self.system.available_memory());
        TrainingResourceSample {
            timestamp: Utc::now(),
            cpu_percent: (cpu_total / logical_cores).clamp(0.0, 100.0),
            process_memory_bytes,
            system_memory_used_bytes,
            system_memory_total_bytes,
            gpus: query_nvidia_gpus().await,
        }
    }
}

impl Default for ResourceSampler {
    fn default() -> Self {
        Self::new()
    }
}

fn descendant_processes(root: Pid, processes: &HashMap<Pid, sysinfo::Process>) -> HashSet<Pid> {
    let mut selected = HashSet::from([root]);
    let mut changed = true;
    while changed {
        changed = false;
        for (pid, process) in processes {
            if !selected.contains(pid)
                && process
                    .parent()
                    .is_some_and(|parent| selected.contains(&parent))
            {
                selected.insert(*pid);
                changed = true;
            }
        }
    }
    selected
}

async fn query_nvidia_gpus() -> Vec<GpuResourceSample> {
    let mut command = Command::new(nvidia_smi_executable());
    command.args([
        "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
        "--format=csv,noheader,nounits",
    ]);
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }
    let Ok(output) = command.output().await else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_nvidia_row)
        .collect()
}

fn nvidia_smi_executable() -> PathBuf {
    #[cfg(windows)]
    {
        let system = PathBuf::from(r"C:\Windows\System32\nvidia-smi.exe");
        if system.is_file() {
            return system;
        }
    }
    PathBuf::from("nvidia-smi")
}

fn parse_nvidia_row(row: &str) -> Option<GpuResourceSample> {
    let columns = row.split(',').map(str::trim).collect::<Vec<_>>();
    if columns.len() != 6 {
        return None;
    }
    Some(GpuResourceSample {
        index: columns[0].parse().ok()?,
        name: columns[1].to_owned(),
        utilization_percent: columns[2].parse().ok()?,
        memory_used_bytes: mib_to_bytes(columns[3].parse().ok()?),
        memory_total_bytes: mib_to_bytes(columns[4].parse().ok()?),
        temperature_celsius: columns[5].parse().ok(),
    })
}

fn mib_to_bytes(value: u64) -> u64 {
    value.saturating_mul(1024 * 1024)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_task_energy_and_force_metrics() {
        let sample = parse_training_line(
            "DEEPMD INFO Batch     200: trn: rmse = 8.42e-03, rmse_e = 2.10e-04, rmse_f = 4.20e-02, lr = 9.99e-04",
        )
        .expect("training metric");
        assert_eq!(sample.step, 200);
        assert_eq!(sample.phase, "train");
        assert_eq!(sample.task, None);
        assert_eq!(sample.values["rmse_e"], 2.10e-04);
        assert_eq!(sample.values["rmse_f"], 4.20e-02);
        assert_eq!(sample.learning_rate, Some(9.99e-04));
    }

    #[test]
    fn preserves_multitask_phase_and_dynamic_dos_metrics() {
        let sample = parse_training_line(
            "Batch    1000: water_val: rmse_global_dos = 1.20e-02, rmse_local_cdf = 3.40e-02",
        )
        .expect("training metric");
        assert_eq!(sample.phase, "validation");
        assert_eq!(sample.task.as_deref(), Some("water"));
        assert_eq!(sample.values.len(), 2);
    }

    #[test]
    fn updates_progress_and_timing_without_fixed_loss_names() {
        let mut snapshot = TrainingSnapshot {
            context: Default::default(),
            current_step: 0,
            eta_seconds: None,
            step_time_seconds: None,
            metrics: Vec::new(),
            resources: Vec::new(),
        };
        assert!(snapshot.apply_log_line(
            "Batch     500: total wall time = 2.00 s, avg = 0.0040 s/step, eta = 0:01:30 at 2026-07-15 10:00"
        ));
        assert_eq!(snapshot.current_step, 500);
        assert_eq!(snapshot.step_time_seconds, Some(0.004));
        assert_eq!(snapshot.eta_seconds, Some(90));
    }

    #[test]
    fn parses_nvidia_csv_rows() {
        let sample =
            parse_nvidia_row("0, NVIDIA RTX 5090, 87, 2048, 24576, 71").expect("GPU sample");
        assert_eq!(sample.index, 0);
        assert_eq!(sample.utilization_percent, 87.0);
        assert_eq!(sample.memory_used_bytes, 2 * 1024 * 1024 * 1024);
    }
}
