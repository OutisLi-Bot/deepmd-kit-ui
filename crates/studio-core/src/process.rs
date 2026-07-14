// SPDX-License-Identifier: LGPL-3.0-or-later
//! Shell-free DeePMD child-process execution with structured streaming events.

use std::process::Stdio;

use anyhow::{Context, Result, anyhow};
use chrono::Utc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{CommandRequest, ProcessEvent, ProcessEventKind, PythonRuntime};

/// Build arguments passed to `python -m deepmd`.
#[must_use]
pub fn build_deepmd_arguments(request: &CommandRequest) -> Vec<String> {
    let mut arguments = vec!["-m".into(), "deepmd".into()];
    if let Some(backend) = request
        .backend
        .as_deref()
        .filter(|backend| !backend.is_empty())
    {
        arguments.push("--backend".into());
        arguments.push(backend.into());
    }
    arguments.push(request.command.clone());
    arguments.extend(request.args.iter().cloned());
    arguments
}

/// Build Python arguments and isolate an installed bundled runtime from the
/// working directory and user site-packages.
#[must_use]
pub fn build_runtime_arguments(runtime: &PythonRuntime, request: &CommandRequest) -> Vec<String> {
    let mut arguments = build_deepmd_arguments(request);
    let _ = runtime;
    arguments.insert(0, "-I".into());
    arguments
}

/// Run a DeePMD command and emit JSON-serializable lifecycle and output events.
pub async fn run_streaming(
    runtime: PythonRuntime,
    request: CommandRequest,
    task_id: Uuid,
    sender: UnboundedSender<ProcessEvent>,
    cancellation: CancellationToken,
) -> Result<i32> {
    if request.command.trim().is_empty() || request.command.starts_with('-') {
        return Err(anyhow!("invalid DeePMD subcommand"));
    }
    let mut command = Command::new(runtime.executable());
    command
        .args(build_runtime_arguments(&runtime, &request))
        .current_dir(&request.working_directory)
        .envs(&request.environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    runtime.configure_command(&mut command);
    let mut child = command.spawn().with_context(|| {
        format!(
            "failed to start DeePMD with {}",
            runtime.executable().display()
        )
    })?;
    let pid = child.id();
    emit(
        &sender,
        ProcessEvent {
            task_id,
            kind: ProcessEventKind::Started,
            timestamp: Utc::now(),
            message: None,
            pid,
            exit_code: None,
            cancelled: false,
        },
    );

    let stdout = child.stdout.take().context("DeePMD stdout was not piped")?;
    let stderr = child.stderr.take().context("DeePMD stderr was not piped")?;
    let stdout_sender = sender.clone();
    let stderr_sender = sender.clone();
    let stdout_task = tokio::spawn(read_lines(
        stdout,
        task_id,
        ProcessEventKind::Stdout,
        stdout_sender,
    ));
    let stderr_task = tokio::spawn(read_lines(
        stderr,
        task_id,
        ProcessEventKind::Stderr,
        stderr_sender,
    ));

    let mut cancelled = false;
    let status = tokio::select! {
        status = child.wait() => status.context("failed while waiting for DeePMD")?,
        () = cancellation.cancelled() => {
            cancelled = true;
            child.kill().await.context("failed to terminate DeePMD")?;
            child.wait().await.context("failed while reaping cancelled DeePMD")?
        }
    };
    let _ = stdout_task.await;
    let _ = stderr_task.await;
    let exit_code = status.code().unwrap_or(if cancelled { 130 } else { 1 });
    emit(
        &sender,
        ProcessEvent {
            task_id,
            kind: ProcessEventKind::Finished,
            timestamp: Utc::now(),
            message: None,
            pid,
            exit_code: Some(exit_code),
            cancelled,
        },
    );
    Ok(exit_code)
}

async fn read_lines<R>(
    reader: R,
    task_id: Uuid,
    kind: ProcessEventKind,
    sender: UnboundedSender<ProcessEvent>,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        emit(
            &sender,
            ProcessEvent {
                task_id,
                kind,
                timestamp: Utc::now(),
                message: Some(line),
                pid: None,
                exit_code: None,
                cancelled: false,
            },
        );
    }
}

fn emit(sender: &UnboundedSender<ProcessEvent>, event: ProcessEvent) {
    let _ = sender.send(event);
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn builds_shell_free_backend_command() {
        let request = CommandRequest {
            backend: Some("pytorch".into()),
            command: "train".into(),
            args: vec![
                "input with space.json".into(),
                "--skip-neighbor-stat".into(),
            ],
            working_directory: PathBuf::from("."),
            environment: BTreeMap::new(),
            label: None,
        };
        assert_eq!(
            build_deepmd_arguments(&request),
            [
                "-m",
                "deepmd",
                "--backend",
                "pytorch",
                "train",
                "input with space.json",
                "--skip-neighbor-stat",
            ]
        );
    }
}
