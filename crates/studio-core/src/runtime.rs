// SPDX-License-Identifier: LGPL-3.0-or-later
//! Resolution and invocation of isolated application-owned Python runtimes.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result, anyhow};
use directories::ProjectDirs;
use serde_json::Value;
use tokio::process::Command;

use crate::RuntimeSource;

/// Resolved application-owned Python interpreter.
#[derive(Clone, Debug)]
pub struct PythonRuntime {
    prefix: PathBuf,
    executable: PathBuf,
    source: RuntimeSource,
}

impl PythonRuntime {
    /// Resolve an isolated runtime without consulting the host Python setup.
    ///
    /// The managed application-data runtime takes precedence over the immutable
    /// installer payload. Conda, `PATH`, `PYTHONHOME`, and source checkouts are
    /// deliberately never considered.
    pub fn isolated(resource_dir: Option<&Path>) -> Result<Self> {
        let mut candidates = Vec::new();
        if let Some(root) = managed_runtime_root() {
            candidates.push((root, RuntimeSource::Managed));
        }
        if let Some(resources) = resource_dir {
            candidates.push((resources.join("runtime"), RuntimeSource::Bundled));
        }
        for (prefix, source) in &candidates {
            let executable = python_in_prefix(prefix);
            if executable.is_file() {
                return Ok(Self {
                    prefix: prefix.clone(),
                    executable,
                    source: *source,
                });
            }
        }
        let searched = candidates
            .iter()
            .map(|(prefix, _)| python_in_prefix(prefix).display().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        Err(anyhow!(
            "the isolated DeePMD runtime is missing or incomplete; searched: {searched}"
        ))
    }

    /// Return the executable passed to child processes.
    #[must_use]
    pub fn executable(&self) -> &Path {
        &self.executable
    }

    /// Return the isolated Python prefix containing the executable and packages.
    #[must_use]
    pub fn prefix(&self) -> &Path {
        &self.prefix
    }

    /// Return how the runtime was discovered.
    #[must_use]
    pub fn source(&self) -> RuntimeSource {
        self.source
    }

    /// Execute a machine bridge operation and parse its JSON response.
    pub async fn bridge(&self, operation: &str) -> Result<Value> {
        let mut command = Command::new(&self.executable);
        command.args(["-I", "-m", "deepmd_ui.bridge", operation]);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        self.configure_command(&mut command);
        let output = command
            .output()
            .await
            .with_context(|| format!("failed to start {}", self.executable.display()))?;
        if !output.status.success() {
            return Err(anyhow!(
                "DeePMD bridge failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        serde_json::from_slice(&output.stdout).context("DeePMD bridge emitted invalid JSON")
    }

    /// Apply environment isolation to every child process.
    pub(crate) fn configure_command(&self, command: &mut Command) {
        command
            .env_remove("CONDA_PREFIX")
            .env_remove("CONDA_DEFAULT_ENV")
            .env_remove("PYTHONHOME")
            .env_remove("PYTHONPATH")
            .env("DPMD_STUDIO_BUNDLED", "1")
            .env("DPMD_UI_ISOLATED", "1")
            .env("PYTHONNOUSERSITE", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1");
    }
}

/// Return the private mutable runtime directory used for in-application updates.
#[must_use]
pub fn managed_runtime_root() -> Option<PathBuf> {
    ProjectDirs::from("org", "DeepModeling", "DeePMD Studio")
        .map(|directories| directories.data_local_dir().join("runtime"))
}

fn python_in_prefix(prefix: &Path) -> PathBuf {
    if cfg!(windows) {
        prefix.join("python.exe")
    } else {
        prefix.join("bin").join("python3")
    }
}

#[cfg(test)]
fn bundled_python(resources: &Path) -> PathBuf {
    python_in_prefix(&resources.join("runtime"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_path_matches_platform_layout() {
        let path = bundled_python(Path::new("resources"));
        if cfg!(windows) {
            assert!(path.ends_with("runtime/python.exe"));
        } else {
            assert!(path.ends_with("runtime/bin/python3"));
        }
    }

    #[test]
    fn managed_runtime_stays_in_application_data() {
        let path = managed_runtime_root().expect("application data directory");
        assert!(path.ends_with("runtime"));
        assert!(
            !path
                .to_string_lossy()
                .to_ascii_lowercase()
                .contains("conda")
        );
    }
}
