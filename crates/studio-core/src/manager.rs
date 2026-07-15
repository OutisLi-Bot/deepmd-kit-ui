// SPDX-License-Identifier: LGPL-3.0-or-later
//! Runtime channel resolution and atomic application-private environment updates.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::Command;
use uuid::Uuid;

use crate::{PythonRuntime, managed_runtime_root};

const OFFICIAL_REPOSITORY: &str = "https://github.com/deepmodeling/deepmd-kit.git";
const APPLICATION_REPOSITORY_SLUG: &str = "OutisLi-Bot/deepmd-kit-ui";

/// DeePMD source selection policy for a managed runtime.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeChannel {
    /// Latest official DeePMD-kit GitHub release tag.
    #[default]
    Stable,
    /// Latest commit on the official `master` branch.
    Beta,
    /// User-selected GitHub repository and ref.
    Custom,
}

/// Persisted runtime source and network settings.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct RuntimeSettings {
    /// Selected update channel.
    pub channel: RuntimeChannel,
    /// Custom repository URL. Official channels ignore this field.
    pub repository: String,
    /// Custom branch, tag, or commit. Beta always resolves `master`.
    pub git_ref: String,
    /// Optional URL prefix such as a GitHub download proxy.
    pub github_proxy: String,
}

impl Default for RuntimeSettings {
    fn default() -> Self {
        Self {
            channel: RuntimeChannel::Stable,
            repository: OFFICIAL_REPOSITORY.into(),
            git_ref: "master".into(),
            github_proxy: "https://gh-proxy.com".into(),
        }
    }
}

/// One immutable source commit selected by the runtime manager.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct RuntimePlan {
    pub schema_version: u32,
    pub channel: RuntimeChannel,
    pub repository: String,
    pub repository_slug: String,
    pub requested_ref: String,
    pub resolved_ref: String,
    pub commit: String,
    pub short_commit: String,
    pub display_version: String,
    pub archive_url: String,
    pub github_proxy: String,
    pub update_mode: String,
}

/// Result of staging, validating, and activating a managed runtime.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RuntimeInstallResult {
    pub schema_version: u32,
    pub runtime: String,
    pub plan: RuntimePlan,
    pub doctor: Value,
    pub restart_required: bool,
}

/// One immutable DeePMD Studio release asset selected for this machine.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ApplicationUpdatePlan {
    pub schema_version: u32,
    pub repository_slug: String,
    pub current_version: String,
    pub latest_version: String,
    pub tag: String,
    pub update_available: bool,
    pub platform_key: String,
    pub asset_name: String,
    pub asset_url: String,
    pub sha256: String,
    pub bytes: u64,
    pub github_proxy: String,
}

/// A downloaded application installer whose release hash has been verified.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ApplicationDownloadResult {
    pub schema_version: u32,
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    pub plan: ApplicationUpdatePlan,
}

/// Read persisted settings, returning safe official defaults on first launch.
pub fn load_runtime_settings() -> Result<RuntimeSettings> {
    let path = settings_path().context("application config directory is unavailable")?;
    if !path.is_file() {
        return Ok(RuntimeSettings::default());
    }
    let data = fs::read(&path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_slice(&data).context("runtime settings contain invalid JSON")
}

/// Persist runtime settings below the application's private config directory.
pub fn save_runtime_settings(settings: &RuntimeSettings) -> Result<()> {
    let path = settings_path().context("application config directory is unavailable")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec_pretty(settings)?)?;
    Ok(())
}

/// Resolve settings to a tag/branch commit through the bundled manager script.
pub async fn resolve_runtime_plan(
    runtime: &PythonRuntime,
    manager_script: &Path,
    settings: &RuntimeSettings,
) -> Result<RuntimePlan> {
    let channel = serde_json::to_value(settings.channel)?
        .as_str()
        .context("runtime channel serialization failed")?
        .to_owned();
    let output = run_manager(
        runtime,
        manager_script,
        [
            "resolve".into(),
            "--channel".into(),
            channel,
            "--repository".into(),
            settings.repository.clone(),
            "--ref".into(),
            settings.git_ref.clone(),
            "--github-proxy".into(),
            settings.github_proxy.clone(),
        ],
    )
    .await?;
    serde_json::from_slice(&output).context("runtime resolver emitted invalid JSON")
}

/// Rebuild and atomically activate an application-private Python runtime.
pub async fn install_runtime(
    runtime: &PythonRuntime,
    manager_script: &Path,
    settings: &RuntimeSettings,
) -> Result<RuntimeInstallResult> {
    let plan = resolve_runtime_plan(runtime, manager_script, settings).await?;
    let current = managed_runtime_root().context("application data directory is unavailable")?;
    let parent = current
        .parent()
        .context("managed runtime has no parent directory")?;
    fs::create_dir_all(parent)?;
    let staging = parent.join(format!("runtime-staging-{}", Uuid::new_v4()));
    let plan_json = serde_json::to_string(&plan)?;
    let output = run_manager(
        runtime,
        manager_script,
        [
            "rebuild".into(),
            "--base".into(),
            runtime.prefix().display().to_string(),
            "--output".into(),
            staging.display().to_string(),
            "--plan-json".into(),
            plan_json,
        ],
    )
    .await;
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    let mut result: RuntimeInstallResult =
        serde_json::from_slice(&output).context("runtime installer emitted invalid JSON")?;

    let backup = parent.join(format!("runtime-backup-{}", Uuid::new_v4()));
    if current.exists() {
        fs::rename(&current, &backup).with_context(|| {
            format!(
                "failed to move the previous runtime to {}",
                backup.display()
            )
        })?;
    }
    if let Err(error) = fs::rename(&staging, &current) {
        if backup.exists() {
            let _ = fs::rename(&backup, &current);
        }
        return Err(error).context("failed to activate the staged runtime");
    }
    if backup.exists() {
        let _ = fs::remove_dir_all(backup);
    }
    save_runtime_settings(settings)?;
    result.runtime = current.display().to_string();
    Ok(result)
}

/// Resolve the latest DeePMD Studio release and select this platform's asset.
pub async fn resolve_application_update(
    runtime: &PythonRuntime,
    manager_script: &Path,
    github_proxy: &str,
) -> Result<ApplicationUpdatePlan> {
    let output = run_manager(
        runtime,
        manager_script,
        [
            "app-resolve".into(),
            "--current-version".into(),
            env!("CARGO_PKG_VERSION").into(),
            "--platform".into(),
            std::env::consts::OS.into(),
            "--arch".into(),
            std::env::consts::ARCH.into(),
            "--repository-slug".into(),
            APPLICATION_REPOSITORY_SLUG.into(),
            "--github-proxy".into(),
            github_proxy.into(),
        ],
    )
    .await?;
    serde_json::from_slice(&output).context("application update resolver emitted invalid JSON")
}

/// Download and verify the application installer selected by a release plan.
pub async fn download_application_update(
    runtime: &PythonRuntime,
    manager_script: &Path,
    plan: &ApplicationUpdatePlan,
) -> Result<ApplicationDownloadResult> {
    let output_root =
        application_updates_root().context("application update directory is unavailable")?;
    fs::create_dir_all(&output_root)?;
    let output = run_manager(
        runtime,
        manager_script,
        [
            "app-download".into(),
            "--output".into(),
            output_root.display().to_string(),
            "--plan-json".into(),
            serde_json::to_string(plan)?,
        ],
    )
    .await?;
    serde_json::from_slice(&output).context("application updater emitted invalid JSON")
}

/// Return the private directory that may contain verified application installers.
#[must_use]
pub fn application_updates_root() -> Option<PathBuf> {
    ProjectDirs::from("org", "DeepModeling", "DeePMD Studio")
        .map(|directories| directories.data_local_dir().join("updates"))
}

async fn run_manager<const N: usize>(
    runtime: &PythonRuntime,
    manager_script: &Path,
    arguments: [String; N],
) -> Result<Vec<u8>> {
    if !manager_script.is_file() {
        return Err(anyhow!(
            "runtime manager resource is missing: {}",
            manager_script.display()
        ));
    }
    let mut command = Command::new(runtime.background_executable());
    command
        .arg("-I")
        .arg(manager_script)
        .args(arguments)
        .kill_on_drop(true);
    runtime.configure_command(&mut command);
    let output = command
        .output()
        .await
        .context("failed to start the isolated runtime manager")?;
    if !output.status.success() {
        return Err(anyhow!(
            "runtime manager failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

fn settings_path() -> Option<PathBuf> {
    ProjectDirs::from("org", "DeepModeling", "DeePMD Studio")
        .map(|directories| directories.config_dir().join("runtime-settings.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_track_the_official_stable_channel() {
        let settings = RuntimeSettings::default();
        assert_eq!(settings.channel, RuntimeChannel::Stable);
        assert_eq!(settings.repository, OFFICIAL_REPOSITORY);
        assert_eq!(settings.git_ref, "master");
        assert_eq!(settings.github_proxy, "https://gh-proxy.com");
    }
}
