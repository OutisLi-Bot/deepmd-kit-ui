// SPDX-License-Identifier: LGPL-3.0-or-later
//! Resolution and invocation of isolated application-owned Python runtimes.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result, anyhow};
use directories::ProjectDirs;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::RuntimeSource;

/// Resolved application-owned Python interpreter.
#[derive(Clone, Debug)]
pub struct PythonRuntime {
    prefix: PathBuf,
    executable: PathBuf,
    windowless_executable: Option<PathBuf>,
    source: RuntimeSource,
    bridge_script: Option<PathBuf>,
}

impl PythonRuntime {
    /// Resolve an isolated runtime without consulting the host Python setup.
    ///
    /// The managed application-data runtime takes precedence over the immutable
    /// installer payload. Conda, `PATH`, `PYTHONHOME`, and source checkouts are
    /// deliberately never considered.
    pub fn isolated(resource_dir: Option<&Path>) -> Result<Self> {
        let mut candidates = Vec::new();
        let bridge_script = packaged_bridge(resource_dir);
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
                    windowless_executable: windowless_python(prefix),
                    source: *source,
                    bridge_script: bridge_script.clone(),
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

    /// Return the interpreter used for background machine-protocol work.
    ///
    /// Windows runtimes include ``pythonw.exe``, which accepts redirected
    /// standard streams without allocating even a headless console host.
    #[must_use]
    pub(crate) fn background_executable(&self) -> &Path {
        self.windowless_executable
            .as_deref()
            .unwrap_or(&self.executable)
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

    /// Build a fast runtime summary from the installer manifest.
    ///
    /// This intentionally does not start Python or initialize a compute
    /// framework. The desktop can render immediately, then replace this
    /// summary with the full bridge doctor report in the background.
    #[must_use]
    pub fn summary(&self) -> Value {
        let manifest = fs::read(self.prefix.join("deepmd-ui-runtime.json"))
            .ok()
            .and_then(|data| serde_json::from_slice::<Value>(&data).ok());
        let packages = manifest
            .as_ref()
            .and_then(|value| value.get("packages"))
            .and_then(Value::as_object);
        let package_version = |name: &str| {
            packages
                .and_then(|rows| rows.get(name))
                .and_then(Value::as_str)
        };
        let has_package = |name: &str| package_version(name).is_some();
        let accelerator_hint = manifest
            .as_ref()
            .and_then(|value| value.get("accelerator"))
            .and_then(Value::as_str)
            .unwrap_or("cpu");
        let accelerator_kind = if accelerator_hint.starts_with("cu") {
            "cuda"
        } else if accelerator_hint == "metal" || accelerator_hint == "mps" {
            "mps"
        } else {
            "cpu"
        };
        let torch_version = package_version("torch");
        let triton_distribution = package_version("triton-windows");
        let triton_version = package_version("triton").or(triton_distribution);
        let deepmd_version = package_version("deepmd-kit").unwrap_or("unknown");
        let python_version = manifest
            .as_ref()
            .and_then(|value| value.get("python"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let package_root = if cfg!(windows) {
            self.prefix.join("Lib").join("site-packages").join("deepmd")
        } else {
            self.prefix.join("lib").join("site-packages").join("deepmd")
        };
        let platform = match std::env::consts::OS {
            "windows" => "Windows",
            "macos" => "macOS",
            "linux" => "Linux",
            other => other,
        };

        json!({
            "schema_version": 1,
            "deepmd_version": deepmd_version,
            "python": {
                "version": python_version,
                "executable": self.executable.display().to_string(),
                "prefix": self.prefix.display().to_string(),
                "bundled": true,
            },
            "platform": {
                "system": platform,
                "release": "",
                "machine": std::env::consts::ARCH,
                "node": "",
            },
            "package_root": package_root.display().to_string(),
            "backends": [
                {"id": "dpmodel", "package": "numpy", "available": has_package("deepmd-kit")},
                {"id": "jax", "package": "jax", "available": has_package("jax")},
                {"id": "paddle", "package": "paddle", "available": has_package("paddle")},
                {"id": "pytorch", "package": "torch", "available": has_package("torch")},
                {"id": "pytorch-exportable", "package": "torch", "available": has_package("torch")},
                {"id": "tensorflow", "package": "tensorflow", "available": has_package("tensorflow")},
                {"id": "tensorflow2", "package": "tensorflow", "available": has_package("tensorflow")},
            ],
            "accelerator": {
                "kind": accelerator_kind,
                "available": false,
                "devices": [],
                "torch_version": torch_version,
                "cuda_version": cuda_version_from_hint(accelerator_hint),
                "probing": true,
            },
            "triton": {
                "available": triton_version.is_some(),
                "driver_ready": false,
                "version": triton_version,
                "distribution": triton_distribution,
                "probing": true,
            },
            "runtime_manifest": manifest,
        })
    }

    /// Execute a machine bridge operation and parse its JSON response.
    pub async fn bridge(&self, operation: &str) -> Result<Value> {
        let mut command = self.bridge_command(operation);
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

    /// Execute a bridge operation with a JSON request on standard input.
    pub async fn bridge_with_payload(&self, operation: &str, payload: &Value) -> Result<Value> {
        let mut command = self.bridge_command(operation);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        self.configure_command(&mut command);
        let mut child = command
            .spawn()
            .with_context(|| format!("failed to start {}", self.executable.display()))?;
        let request = serde_json::to_vec(payload).context("failed to serialize bridge request")?;
        let mut stdin = child
            .stdin
            .take()
            .context("failed to open DeePMD bridge standard input")?;
        stdin
            .write_all(&request)
            .await
            .context("failed to write DeePMD bridge request")?;
        drop(stdin);
        let output = child
            .wait_with_output()
            .await
            .context("failed to wait for DeePMD bridge")?;
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
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8");
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    fn bridge_command(&self, operation: &str) -> Command {
        let mut command = Command::new(self.background_executable());
        command.arg("-I");
        if let Some(script) = &self.bridge_script {
            command.arg(script);
        } else {
            // Compatibility fallback for development runtimes assembled
            // before the bridge became an application-owned resource.
            command.args(["-m", "deepmd_ui.bridge"]);
        }
        command.arg(operation);
        command
    }
}

fn packaged_bridge(resource_dir: Option<&Path>) -> Option<PathBuf> {
    resource_dir
        .map(|root| root.join("bridge").join("deepmd_ui_bridge.py"))
        .filter(|path| path.is_file())
}

fn windowless_python(prefix: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let candidate = prefix.join("pythonw.exe");
        candidate.is_file().then_some(candidate)
    }
    #[cfg(not(windows))]
    {
        let _ = prefix;
        None
    }
}

fn cuda_version_from_hint(hint: &str) -> Option<String> {
    let digits = hint.strip_prefix("cu")?;
    if digits.len() < 2 || !digits.chars().all(|value| value.is_ascii_digit()) {
        return None;
    }
    let split = digits.len() - 1;
    Some(format!("{}.{}", &digits[..split], &digits[split..]))
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
    use std::fs;

    use tempfile::tempdir;

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

    #[test]
    fn summary_reads_manifest_without_starting_python() {
        let directory = tempdir().expect("temporary runtime");
        fs::write(
            directory.path().join("deepmd-ui-runtime.json"),
            serde_json::to_vec(&json!({
                "schema_version": 2,
                "python": "3.11.15",
                "accelerator": "cu130",
                "packages": {
                    "deepmd-kit": "3.1.4.dev",
                    "torch": "2.12.1+cu130",
                    "jax": "0.10.2",
                    "triton-windows": "3.7.1.post27"
                }
            }))
            .expect("serialize manifest"),
        )
        .expect("write manifest");
        let runtime = PythonRuntime {
            prefix: directory.path().to_path_buf(),
            executable: directory.path().join("python.exe"),
            windowless_executable: None,
            source: RuntimeSource::Bundled,
            bridge_script: None,
        };

        let summary = runtime.summary();
        assert_eq!(summary["deepmd_version"], "3.1.4.dev");
        assert_eq!(summary["accelerator"]["kind"], "cuda");
        assert_eq!(summary["accelerator"]["cuda_version"], "13.0");
        assert_eq!(summary["accelerator"]["probing"], true);
        assert_eq!(summary["backends"][3]["available"], true);
        assert_eq!(summary["backends"][5]["available"], false);
    }

    #[test]
    fn packaged_bridge_is_owned_by_the_application() {
        let directory = tempdir().expect("temporary resources");
        let bridge = directory.path().join("bridge").join("deepmd_ui_bridge.py");
        fs::create_dir_all(bridge.parent().expect("bridge parent"))
            .expect("create bridge directory");
        fs::write(&bridge, "# test bridge\n").expect("write bridge");

        assert_eq!(packaged_bridge(Some(directory.path())), Some(bridge));
    }

    #[cfg(windows)]
    #[test]
    fn background_bridge_prefers_pythonw_on_windows() {
        let directory = tempdir().expect("temporary runtime");
        let pythonw = directory.path().join("pythonw.exe");
        fs::write(&pythonw, b"").expect("write pythonw marker");

        assert_eq!(windowless_python(directory.path()), Some(pythonw));
    }
}
