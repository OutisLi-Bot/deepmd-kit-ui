// SPDX-License-Identifier: LGPL-3.0-or-later
//! Shared execution and machine protocol for DeePMD Studio.

mod manager;
mod process;
mod runtime;
mod types;

pub use manager::{
    ApplicationDownloadResult, ApplicationUpdatePlan, RuntimeChannel, RuntimeInstallResult,
    RuntimePlan, RuntimeSettings, application_updates_root, download_application_update,
    install_runtime, load_runtime_settings, resolve_application_update, resolve_runtime_plan,
    save_runtime_settings,
};
pub use process::{build_deepmd_arguments, build_runtime_arguments, run_streaming};
pub use runtime::{PythonRuntime, managed_runtime_root};
pub use types::{
    CommandRequest, ProcessEvent, ProcessEventKind, RuntimeSource, TaskSnapshot, TaskStatus,
};
