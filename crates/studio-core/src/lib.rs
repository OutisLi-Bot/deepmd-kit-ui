// SPDX-License-Identifier: LGPL-3.0-or-later
//! Shared execution and machine protocol for DeePMD Studio.

mod examples;
mod manager;
mod process;
mod runtime;
mod training;
mod types;

pub use examples::{
    ExampleCatalog, ExampleEntry, PreparedExample, example_directory, list_examples,
    prepare_example, read_example_file,
};
pub use manager::{
    ApplicationDownloadResult, ApplicationUpdatePlan, RuntimeChannel, RuntimeInstallResult,
    RuntimePlan, RuntimeSettings, application_updates_root, download_application_update,
    install_runtime, load_runtime_settings, resolve_application_update, resolve_runtime_plan,
    save_runtime_settings,
};
pub use process::{build_deepmd_arguments, build_runtime_arguments, run_streaming};
pub use runtime::{PythonRuntime, managed_runtime_root};
pub use training::{ResourceSampler, parse_training_line};
pub use types::{
    CommandRequest, GpuResourceSample, ProcessEvent, ProcessEventKind, RuntimeSource, TaskSnapshot,
    TaskStatus, TrainingContext, TrainingMetricSample, TrainingResourceSample, TrainingSnapshot,
};
