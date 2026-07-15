// SPDX-License-Identifier: LGPL-3.0-or-later
//! Serializable domain models shared by the GUI, TUI, and agent protocol.

use std::collections::BTreeMap;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// One safe, shell-free DeePMD command request.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRequest {
    /// Backend canonical name, such as `pytorch` or `jax`.
    pub backend: Option<String>,
    /// DeePMD subcommand, such as `train` or `test`.
    pub command: String,
    /// Arguments following the DeePMD subcommand.
    #[serde(default)]
    pub args: Vec<String>,
    /// Working directory for relative input and output paths.
    pub working_directory: PathBuf,
    /// Environment overrides passed directly to the child process.
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    /// Human-readable label shown in task history.
    pub label: Option<String>,
    /// Structured context used by the shared training monitor.
    #[serde(default)]
    pub training: Option<TrainingContext>,
}

/// Metadata known before a training process is launched.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingContext {
    /// Input file selected by the user or prepared from an example.
    pub input_path: Option<PathBuf>,
    /// Configured number of optimization steps, when it is explicit.
    pub total_steps: Option<u64>,
    /// Model family shown in the monitor summary.
    pub model_type: Option<String>,
    /// Loss families declared by the input, including multi-task losses.
    #[serde(default)]
    pub loss_types: Vec<String>,
}

/// One dynamic metric report parsed from DeePMD's training logger.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingMetricSample {
    /// Training step associated with this report.
    pub step: u64,
    /// ``train``, ``validation``, or another backend-provided phase.
    pub phase: String,
    /// Multi-task branch name, when present.
    pub task: Option<String>,
    /// Every finite metric emitted by the active loss implementation.
    pub values: BTreeMap<String, f64>,
    /// Learning rate reported with the metric row.
    pub learning_rate: Option<f64>,
    /// Time at which Studio received the report.
    pub timestamp: DateTime<Utc>,
}

/// One NVIDIA device sample collected while a training task is active.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuResourceSample {
    /// Stable device index reported by ``nvidia-smi``.
    pub index: u32,
    /// Human-readable device name.
    pub name: String,
    /// Whole-device utilization in percent.
    pub utilization_percent: f32,
    /// Allocated device memory in bytes.
    pub memory_used_bytes: u64,
    /// Total device memory in bytes.
    pub memory_total_bytes: u64,
    /// Device temperature in Celsius, when reported.
    pub temperature_celsius: Option<f32>,
}

/// CPU, RAM, and accelerator telemetry for a running training process.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingResourceSample {
    /// Time at which the sample was captured.
    pub timestamp: DateTime<Utc>,
    /// Process-tree CPU utilization normalized to the whole machine.
    pub cpu_percent: f32,
    /// Resident memory used by the process tree in bytes.
    pub process_memory_bytes: u64,
    /// System memory currently in use in bytes.
    pub system_memory_used_bytes: u64,
    /// Total physical system memory in bytes.
    pub system_memory_total_bytes: u64,
    /// Available NVIDIA device telemetry. Empty on CPU or Metal systems.
    pub gpus: Vec<GpuResourceSample>,
}

/// Bounded, restorable state rendered by GUI and TUI training monitors.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingSnapshot {
    /// Immutable launch metadata.
    pub context: TrainingContext,
    /// Highest reported optimization step.
    pub current_step: u64,
    /// Backend-estimated remaining duration in seconds.
    pub eta_seconds: Option<u64>,
    /// Average duration of one optimization step in seconds.
    pub step_time_seconds: Option<f64>,
    /// Dynamic metric history from all tasks and phases.
    pub metrics: Vec<TrainingMetricSample>,
    /// Recent hardware utilization history.
    pub resources: Vec<TrainingResourceSample>,
}

/// Lifecycle state persisted for a running or completed command.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    /// The task has been accepted but its process has not started yet.
    Queued,
    /// The DeePMD child process is running.
    Running,
    /// The process exited successfully.
    Succeeded,
    /// The process exited with a non-zero code or could not start.
    Failed,
    /// Cancellation was requested by a client.
    Cancelled,
}

/// Snapshot returned to desktop clients.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    /// Stable task identifier.
    pub id: Uuid,
    /// Original command request.
    pub request: CommandRequest,
    /// Current lifecycle state.
    pub status: TaskStatus,
    /// Process identifier when the process has started.
    pub pid: Option<u32>,
    /// Process exit code when available.
    pub exit_code: Option<i32>,
    /// Time at which the request was accepted.
    pub created_at: DateTime<Utc>,
    /// Time at which the process finished.
    pub finished_at: Option<DateTime<Utc>>,
    /// Bounded recent output used to restore the console after navigation.
    pub log: Vec<String>,
    /// Structured training state for ``train`` tasks.
    pub training: Option<TrainingSnapshot>,
}

impl TaskSnapshot {
    /// Create a queued task for a command request.
    #[must_use]
    pub fn queued(request: CommandRequest) -> Self {
        let training = (request.command == "train").then(|| TrainingSnapshot {
            context: request.training.clone().unwrap_or_default(),
            current_step: 0,
            eta_seconds: None,
            step_time_seconds: None,
            metrics: Vec::new(),
            resources: Vec::new(),
        });
        Self {
            id: Uuid::new_v4(),
            request,
            status: TaskStatus::Queued,
            pid: None,
            exit_code: None,
            created_at: Utc::now(),
            finished_at: None,
            log: Vec::new(),
            training,
        }
    }
}

/// Stream source and lifecycle events produced by a DeePMD child process.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessEventKind {
    /// The process was spawned and a process identifier is available.
    Started,
    /// One UTF-8 line was read from standard output.
    Stdout,
    /// One UTF-8 line was read from standard error.
    Stderr,
    /// The process exited.
    Finished,
    /// The process could not start or an I/O error occurred.
    Error,
}

/// One JSONL-safe process event.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEvent {
    /// Task that produced the event.
    pub task_id: Uuid,
    /// Event category.
    pub kind: ProcessEventKind,
    /// UTC event timestamp.
    pub timestamp: DateTime<Utc>,
    /// Output line or error detail.
    pub message: Option<String>,
    /// Process identifier for a start event.
    pub pid: Option<u32>,
    /// Exit code for a finish event.
    pub exit_code: Option<i32>,
    /// Whether the task was cancelled before exit.
    pub cancelled: bool,
}

/// How the Python executable was resolved.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeSource {
    /// Relocatable runtime bundled in the desktop application resources.
    Bundled,
    /// Isolated runtime installed below the application's private data directory.
    Managed,
}
