// SPDX-License-Identifier: LGPL-3.0-or-later
//! Tauri command surface for DeePMD Studio.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command as StdCommand;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use deepmd_studio_core::{
    ApplicationDownloadResult, ApplicationUpdatePlan, CommandRequest, ExampleCatalog,
    PreparedExample, ProcessEvent, ProcessEventKind, PythonRuntime, ResourceSampler,
    RuntimeInstallResult, RuntimePlan, RuntimeSettings, TaskSnapshot, TaskStatus,
    TrainingResourceSample, TrainingSnapshot, application_updates_root, build_runtime_arguments,
    download_application_update as download_application_installer,
    example_directory as load_example_directory, install_runtime, list_examples as load_examples,
    load_runtime_settings, prepare_example as prepare_example_workspace,
    read_example_file as load_example_file, resolve_application_update, resolve_runtime_plan,
    run_streaming, save_runtime_settings,
};
use directories::UserDirs;
use serde::Serialize;
use serde_json::{Value, json};
use sysinfo::{Disks, System};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{Mutex, RwLock, mpsc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const MAX_LOG_LINES: usize = 4_000;

#[derive(Clone)]
struct TaskManager {
    tasks: Arc<RwLock<HashMap<Uuid, TaskSnapshot>>>,
    cancellations: Arc<Mutex<HashMap<Uuid, CancellationToken>>>,
}

impl TaskManager {
    fn new() -> Self {
        Self {
            tasks: Arc::new(RwLock::new(HashMap::new())),
            cancellations: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn insert(&self, task: TaskSnapshot, cancellation: CancellationToken) {
        self.cancellations
            .lock()
            .await
            .insert(task.id, cancellation);
        self.tasks.write().await.insert(task.id, task);
    }

    async fn apply(&self, event: &ProcessEvent) -> Option<TrainingSnapshot> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(&event.task_id)?;
        let mut training_changed = false;
        match event.kind {
            ProcessEventKind::Started => {
                task.status = TaskStatus::Running;
                task.pid = event.pid;
            }
            ProcessEventKind::Stdout | ProcessEventKind::Stderr => {
                if let Some(message) = &event.message {
                    let prefix = if event.kind == ProcessEventKind::Stderr {
                        "[stderr] "
                    } else {
                        ""
                    };
                    task.log.push(format!("{prefix}{message}"));
                    if task.log.len() > MAX_LOG_LINES {
                        task.log.drain(..task.log.len() - MAX_LOG_LINES);
                    }
                    if let Some(training) = &mut task.training {
                        training_changed = training.apply_log_line(message);
                    }
                }
            }
            ProcessEventKind::Finished => {
                task.exit_code = event.exit_code;
                task.finished_at = Some(event.timestamp);
                task.status = if event.cancelled {
                    TaskStatus::Cancelled
                } else if event.exit_code == Some(0) {
                    TaskStatus::Succeeded
                } else {
                    TaskStatus::Failed
                };
            }
            ProcessEventKind::Error => {
                if let Some(message) = &event.message {
                    task.log.push(format!("[studio] {message}"));
                }
                task.finished_at = Some(event.timestamp);
                task.status = TaskStatus::Failed;
            }
        }
        training_changed.then(|| task.training.clone()).flatten()
    }

    async fn fail(&self, task_id: Uuid, error: String) -> ProcessEvent {
        let event = ProcessEvent {
            task_id,
            kind: ProcessEventKind::Error,
            timestamp: Utc::now(),
            message: Some(error),
            pid: None,
            exit_code: Some(1),
            cancelled: false,
        };
        self.apply(&event).await;
        event
    }

    async fn monitor_state(&self, task_id: Uuid) -> Option<(TaskStatus, Option<u32>, bool)> {
        self.tasks
            .read()
            .await
            .get(&task_id)
            .map(|task| (task.status, task.pid, task.training.is_some()))
    }

    async fn push_resource(
        &self,
        task_id: Uuid,
        sample: TrainingResourceSample,
    ) -> Option<TrainingSnapshot> {
        let mut tasks = self.tasks.write().await;
        let training = tasks.get_mut(&task_id)?.training.as_mut()?;
        training.push_resource(sample);
        Some(training.clone())
    }

    async fn remove_cancellation(&self, task_id: Uuid) {
        self.cancellations.lock().await.remove(&task_id);
    }
}

struct AppState {
    runtime: PythonRuntime,
    runtime_manager_script: PathBuf,
    examples_root: PathBuf,
    tasks: TaskManager,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrainingUpdate {
    task_id: Uuid,
    training: TrainingSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeLocation {
    executable: String,
    source: deepmd_studio_core::RuntimeSource,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OperatingSystemReport {
    name: String,
    version: String,
    kernel: String,
    hostname: String,
    architecture: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CpuReport {
    brand: String,
    vendor: String,
    physical_cores: usize,
    logical_cores: usize,
    frequency_mhz: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryReport {
    total_bytes: u64,
    available_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskReport {
    name: String,
    mount_point: String,
    file_system: String,
    kind: String,
    total_bytes: u64,
    available_bytes: u64,
    removable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemReport {
    operating_system: OperatingSystemReport,
    cpu: CpuReport,
    memory: MemoryReport,
    disks: Vec<DiskReport>,
}

fn collect_system_report() -> SystemReport {
    let mut system = System::new_all();
    system.refresh_all();
    let cpu = system.cpus().first();
    let disks = Disks::new_with_refreshed_list()
        .iter()
        .filter(|disk| disk.total_space() > 0)
        .map(|disk| DiskReport {
            name: disk.name().to_string_lossy().into_owned(),
            mount_point: disk.mount_point().display().to_string(),
            file_system: disk.file_system().to_string_lossy().into_owned(),
            kind: format!("{:?}", disk.kind()),
            total_bytes: disk.total_space(),
            available_bytes: disk.available_space(),
            removable: disk.is_removable(),
        })
        .collect();
    SystemReport {
        operating_system: OperatingSystemReport {
            name: System::name().unwrap_or_else(|| std::env::consts::OS.to_owned()),
            version: System::long_os_version().unwrap_or_default(),
            kernel: System::kernel_version().unwrap_or_default(),
            hostname: System::host_name().unwrap_or_default(),
            architecture: std::env::consts::ARCH.to_owned(),
        },
        cpu: CpuReport {
            brand: cpu
                .map(|value| value.brand().trim().to_owned())
                .unwrap_or_default(),
            vendor: cpu
                .map(|value| value.vendor_id().trim().to_owned())
                .unwrap_or_default(),
            physical_cores: system
                .physical_core_count()
                .unwrap_or_else(|| system.cpus().len()),
            logical_cores: system.cpus().len(),
            frequency_mhz: cpu.map_or(0, sysinfo::Cpu::frequency),
        },
        memory: MemoryReport {
            total_bytes: system.total_memory(),
            available_bytes: system.available_memory(),
        },
        disks,
    }
}

#[tauri::command]
async fn get_catalog(state: State<'_, AppState>) -> Result<Value, String> {
    state
        .runtime
        .bridge("catalog")
        .await
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
async fn get_training_schema(state: State<'_, AppState>) -> Result<Value, String> {
    state
        .runtime
        .bridge("train-schema")
        .await
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
async fn inspect_training_input(state: State<'_, AppState>, path: String) -> Result<Value, String> {
    state
        .runtime
        .bridge_with_payload("validate-input", &json!({"path": path}))
        .await
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
async fn validate_training_input(
    state: State<'_, AppState>,
    input: Value,
) -> Result<Value, String> {
    state
        .runtime
        .bridge_with_payload("validate-input", &json!({"input": input}))
        .await
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn save_training_input(path: String, input: Value) -> Result<String, String> {
    let mut destination = PathBuf::from(path);
    if destination.extension().is_none() {
        destination.set_extension("json");
    }
    if destination
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("json"))
    {
        return Err("Generated training inputs must use the .json extension.".into());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "The selected output path has no parent directory.".to_owned())?;
    if !parent.is_dir() {
        return Err(format!(
            "Output directory does not exist: {}",
            parent.display()
        ));
    }
    let mut serialized = serde_json::to_string_pretty(&input)
        .map_err(|error| format!("failed to serialize training input: {error}"))?;
    serialized.push('\n');
    fs::write(&destination, serialized)
        .map_err(|error| format!("failed to save {}: {error}", destination.display()))?;
    Ok(destination.display().to_string())
}

#[tauri::command]
fn list_examples(state: State<'_, AppState>) -> Result<ExampleCatalog, String> {
    load_examples(&state.examples_root).map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn read_example_file(state: State<'_, AppState>, path: String) -> Result<String, String> {
    load_example_file(&state.examples_root, &path).map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn get_example_directory(state: State<'_, AppState>, path: String) -> Result<String, String> {
    load_example_directory(&state.examples_root, &path)
        .map(|directory| directory.display().to_string())
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
async fn prepare_example(
    state: State<'_, AppState>,
    example_id: String,
) -> Result<PreparedExample, String> {
    let examples_root = state.examples_root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        prepare_example_workspace(&examples_root, &example_id).map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| format!("example workspace worker failed: {error}"))?
}

#[tauri::command]
async fn get_system_report() -> Result<SystemReport, String> {
    tauri::async_runtime::spawn_blocking(collect_system_report)
        .await
        .map_err(|error| format!("system inventory worker failed: {error}"))
}

#[tauri::command]
async fn get_runtime_report(state: State<'_, AppState>) -> Result<Value, String> {
    state
        .runtime
        .bridge("doctor")
        .await
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn get_runtime_summary(state: State<'_, AppState>) -> Value {
    state.runtime.summary()
}

#[tauri::command]
fn get_runtime_location(state: State<'_, AppState>) -> RuntimeLocation {
    RuntimeLocation {
        executable: state.runtime.executable().display().to_string(),
        source: state.runtime.source(),
    }
}

#[tauri::command]
fn get_runtime_settings() -> Result<RuntimeSettings, String> {
    load_runtime_settings().map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn set_runtime_settings(settings: RuntimeSettings) -> Result<(), String> {
    save_runtime_settings(&settings).map_err(|error| format!("{error:#}"))
}

#[tauri::command]
async fn resolve_runtime_update(
    state: State<'_, AppState>,
    settings: RuntimeSettings,
) -> Result<RuntimePlan, String> {
    resolve_runtime_plan(&state.runtime, &state.runtime_manager_script, &settings)
        .await
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
async fn install_runtime_update(
    state: State<'_, AppState>,
    settings: RuntimeSettings,
) -> Result<RuntimeInstallResult, String> {
    if !state.tasks.cancellations.lock().await.is_empty() {
        return Err("Stop all active DeePMD tasks before rebuilding the runtime.".into());
    }
    install_runtime(&state.runtime, &state.runtime_manager_script, &settings)
        .await
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
async fn check_application_update(
    state: State<'_, AppState>,
    github_proxy: String,
) -> Result<ApplicationUpdatePlan, String> {
    resolve_application_update(&state.runtime, &state.runtime_manager_script, &github_proxy)
        .await
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
async fn download_application_update(
    state: State<'_, AppState>,
    plan: ApplicationUpdatePlan,
) -> Result<ApplicationDownloadResult, String> {
    download_application_installer(&state.runtime, &state.runtime_manager_script, &plan)
        .await
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn launch_application_update(app: AppHandle, installer_path: String) -> Result<(), String> {
    let update_root = application_updates_root()
        .ok_or_else(|| "application update directory is unavailable".to_owned())?;
    let update_root = update_root
        .canonicalize()
        .map_err(|error| format!("failed to resolve application update directory: {error}"))?;
    let installer = PathBuf::from(installer_path)
        .canonicalize()
        .map_err(|error| format!("failed to resolve application installer: {error}"))?;
    if !installer.starts_with(&update_root) || !installer.is_file() {
        return Err("refusing to launch an installer outside the private update directory".into());
    }

    #[cfg(target_os = "windows")]
    StdCommand::new(&installer)
        .spawn()
        .map_err(|error| format!("failed to launch the Windows installer: {error}"))?;
    #[cfg(target_os = "macos")]
    StdCommand::new("open")
        .arg(&installer)
        .spawn()
        .map_err(|error| format!("failed to open the macOS installer: {error}"))?;
    #[cfg(target_os = "linux")]
    StdCommand::new("xdg-open")
        .arg(&installer)
        .spawn()
        .map_err(|error| format!("failed to open the Linux installer: {error}"))?;

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(650)).await;
        app.exit(0);
    });
    Ok(())
}

#[tauri::command]
fn get_default_working_directory() -> String {
    UserDirs::new()
        .map(|directories| directories.home_dir().display().to_string())
        .unwrap_or_else(|| ".".into())
}

#[tauri::command]
fn restart_application(app: AppHandle) {
    app.restart();
}

#[tauri::command]
async fn start_task(
    app: AppHandle,
    state: State<'_, AppState>,
    request: CommandRequest,
) -> Result<TaskSnapshot, String> {
    if !request.working_directory.is_dir() {
        return Err(format!(
            "Working directory does not exist: {}",
            request.working_directory.display()
        ));
    }
    let task = TaskSnapshot::queued(request.clone());
    let task_id = task.id;
    let cancellation = CancellationToken::new();
    state.tasks.insert(task.clone(), cancellation.clone()).await;
    let runtime = state.runtime.clone();
    let manager = state.tasks.clone();
    if task.training.is_some() {
        let monitor_app = app.clone();
        let monitor_manager = manager.clone();
        tauri::async_runtime::spawn(async move {
            monitor_training_resources(monitor_app, monitor_manager, task_id).await;
        });
    }
    tauri::async_runtime::spawn(async move {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let process = tokio::spawn(run_streaming(
            runtime,
            request,
            task_id,
            sender,
            cancellation,
        ));
        while let Some(event) = receiver.recv().await {
            let training = manager.apply(&event).await;
            let _ = app.emit("studio://task-event", &event);
            if let Some(training) = training {
                let _ = app.emit(
                    "studio://training-update",
                    &TrainingUpdate { task_id, training },
                );
            }
        }
        match process.await {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                let event = manager.fail(task_id, format!("{error:#}")).await;
                let _ = app.emit("studio://task-event", &event);
            }
            Err(error) => {
                let event = manager
                    .fail(task_id, format!("task worker failed: {error}"))
                    .await;
                let _ = app.emit("studio://task-event", &event);
            }
        }
        manager.remove_cancellation(task_id).await;
    });
    Ok(task)
}

async fn monitor_training_resources(app: AppHandle, manager: TaskManager, task_id: Uuid) {
    let mut sampler = ResourceSampler::new();
    let mut interval = tokio::time::interval(Duration::from_millis(1_200));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let Some((status, pid, is_training)) = manager.monitor_state(task_id).await else {
            return;
        };
        if !is_training
            || matches!(
                status,
                TaskStatus::Succeeded | TaskStatus::Failed | TaskStatus::Cancelled
            )
        {
            return;
        }
        let Some(pid) = pid.filter(|_| status == TaskStatus::Running) else {
            continue;
        };
        let sample = sampler.sample(pid).await;
        if let Some(training) = manager.push_resource(task_id, sample).await {
            let _ = app.emit(
                "studio://training-update",
                &TrainingUpdate { task_id, training },
            );
        }
    }
}

#[tauri::command]
async fn list_tasks(state: State<'_, AppState>) -> Result<Vec<TaskSnapshot>, String> {
    let mut tasks: Vec<_> = state.tasks.tasks.read().await.values().cloned().collect();
    tasks.sort_by_key(|task| std::cmp::Reverse(task.created_at));
    Ok(tasks)
}

#[tauri::command]
async fn cancel_task(state: State<'_, AppState>, task_id: Uuid) -> Result<(), String> {
    let cancellations = state.tasks.cancellations.lock().await;
    let cancellation = cancellations
        .get(&task_id)
        .ok_or_else(|| format!("Task {task_id} is not running"))?;
    cancellation.cancel();
    Ok(())
}

#[tauri::command]
fn preview_command(state: State<'_, AppState>, request: CommandRequest) -> Vec<String> {
    let mut command = vec![state.runtime.executable().display().to_string()];
    command.extend(build_runtime_arguments(&state.runtime, &request));
    command
}

/// Start the DeePMD Studio Tauri application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                window.maximize()?;
            }
            let resources = app.path().resource_dir().ok();
            let runtime = PythonRuntime::isolated(resources.as_deref())?;
            let active_examples = runtime.prefix().join("deepmd-ui-examples");
            let bundled_examples = resources
                .as_deref()
                .map(|root| root.join("runtime").join("deepmd-ui-examples"));
            let examples_root = if active_examples.is_dir() {
                active_examples
            } else {
                bundled_examples.unwrap_or(active_examples)
            };
            let packaged_runtime_manager = resources
                .as_deref()
                .map(|path| path.join("runtime-manager").join("runtime_manager.py"))
                .ok_or_else(|| anyhow::anyhow!("application resource directory is unavailable"))?;
            #[cfg(debug_assertions)]
            let runtime_manager_script = if packaged_runtime_manager.is_file() {
                packaged_runtime_manager
            } else {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("scripts")
                    .join("runtime_manager.py")
            };
            #[cfg(not(debug_assertions))]
            let runtime_manager_script = packaged_runtime_manager;
            app.manage(AppState {
                runtime,
                runtime_manager_script,
                examples_root,
                tasks: TaskManager::new(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_catalog,
            get_training_schema,
            inspect_training_input,
            validate_training_input,
            save_training_input,
            list_examples,
            read_example_file,
            get_example_directory,
            prepare_example,
            get_system_report,
            get_runtime_report,
            get_runtime_summary,
            get_runtime_location,
            get_runtime_settings,
            set_runtime_settings,
            resolve_runtime_update,
            install_runtime_update,
            check_application_update,
            download_application_update,
            launch_application_update,
            restart_application,
            get_default_working_directory,
            start_task,
            list_tasks,
            cancel_task,
            preview_command,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run DeePMD Studio");
}
