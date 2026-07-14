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
}

impl TaskSnapshot {
    /// Create a queued task for a command request.
    #[must_use]
    pub fn queued(request: CommandRequest) -> Self {
        Self {
            id: Uuid::new_v4(),
            request,
            status: TaskStatus::Queued,
            pid: None,
            exit_code: None,
            created_at: Utc::now(),
            finished_at: None,
            log: Vec::new(),
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
