// SPDX-License-Identifier: LGPL-3.0-or-later
//! Version-matched DeePMD example discovery and safe workspace preparation.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// One runnable training input discovered below the active runtime's examples.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExampleEntry {
    /// Stable path-based identifier.
    pub id: String,
    /// Relative source path rendered in the tree.
    pub path: String,
    /// Concise user-facing title.
    pub title: String,
    /// Top-level DeePMD example family.
    pub category: String,
    /// Model or descriptor family inferred from the input.
    pub model_type: String,
    /// Configured loss families, including multi-task inputs.
    pub loss_types: Vec<String>,
    /// Explicit optimization-step target, when present.
    pub total_steps: Option<u64>,
    /// Number of configured training systems when it is statically known.
    pub system_count: usize,
    /// Suggested backend inferred from an explicit file name.
    pub suggested_backend: Option<String>,
    /// Nearby README introduction, when available.
    pub description: Option<String>,
}

/// Runnable examples shipped with the currently active isolated runtime.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExampleCatalog {
    /// Hierarchical entries sorted by source path.
    pub entries: Vec<ExampleEntry>,
}

/// Writable copy prepared for an example training run.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedExample {
    /// Absolute copied input path.
    pub input_path: PathBuf,
    /// Directory from which DeePMD must resolve relative data paths.
    pub working_directory: PathBuf,
    /// Root of the disposable writable example workspace.
    pub workspace_root: PathBuf,
}

/// Discover runnable JSON training inputs without exposing raw data files.
pub fn list_examples(examples_root: &Path) -> Result<ExampleCatalog> {
    if !examples_root.is_dir() {
        return Ok(ExampleCatalog::default());
    }
    let mut files = Vec::new();
    collect_json_files(examples_root, examples_root, &mut files)?;
    let mut entries = files
        .into_iter()
        .filter_map(|path| build_entry(examples_root, &path).transpose())
        .collect::<Result<Vec<_>>>()?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(ExampleCatalog { entries })
}

/// Read a selected example input after enforcing the runtime examples boundary.
pub fn read_example_file(examples_root: &Path, relative_path: &str) -> Result<String> {
    let path = safe_example_path(examples_root, relative_path)?;
    fs::read_to_string(&path).with_context(|| format!("failed to read {}", path.display()))
}

/// Copy the selected top-level example family into a new writable workspace.
pub fn prepare_example(examples_root: &Path, example_id: &str) -> Result<PreparedExample> {
    let catalog = list_examples(examples_root)?;
    let entry = catalog
        .entries
        .iter()
        .find(|entry| entry.id == example_id)
        .ok_or_else(|| anyhow!("Example is unavailable: {example_id}"))?;
    let relative = PathBuf::from(&entry.path);
    let category = relative
        .components()
        .next()
        .and_then(component_text)
        .ok_or_else(|| anyhow!("Example path has no category"))?;
    let source_category = safe_example_path(examples_root, &category)?;
    let workspace_base = ProjectDirs::from("org", "DeepModeling", "DeePMD Studio")
        .map(|directories| directories.data_local_dir().join("example-workspaces"))
        .ok_or_else(|| anyhow!("application workspace directory is unavailable"))?;
    fs::create_dir_all(&workspace_base).context("failed to create example workspace root")?;
    let workspace_root = workspace_base.join(format!(
        "{}-{}",
        sanitize_segment(&category),
        &Uuid::new_v4().simple().to_string()[..8]
    ));
    let destination_category = workspace_root.join(&category);
    copy_tree(&source_category, &destination_category)?;
    let input_path = workspace_root.join(&relative);
    let working_directory = input_path
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow!("prepared example has no working directory"))?;
    Ok(PreparedExample {
        input_path,
        working_directory,
        workspace_root,
    })
}

fn collect_json_files(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(directory)
        .with_context(|| format!("failed to scan {}", directory.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            let relative = path.strip_prefix(root).unwrap_or(&path);
            if relative
                .components()
                .any(|component| component_text(component).as_deref() == Some("nvnmd"))
            {
                continue;
            }
            collect_json_files(root, &path, files)?;
        } else if path
            .extension()
            .is_some_and(|value| value.eq_ignore_ascii_case("json"))
            && path.file_name().is_none_or(|value| value != "out.json")
        {
            files.push(path);
        }
    }
    Ok(())
}

fn build_entry(root: &Path, path: &Path) -> Result<Option<ExampleEntry>> {
    let source = fs::read_to_string(path)?;
    let Ok(input) = serde_json::from_str::<Value>(&source) else {
        return Ok(None);
    };
    let Some(object) = input.as_object() else {
        return Ok(None);
    };
    if !object.contains_key("model") || !object.contains_key("training") {
        return Ok(None);
    }
    let relative = path
        .strip_prefix(root)
        .context("example escaped its root")?;
    let path_text = path_to_slashes(relative);
    let category = relative
        .components()
        .next()
        .and_then(component_text)
        .unwrap_or_else(|| "examples".into());
    let model_type = infer_model_type(&input);
    let loss_types = infer_loss_types(&input);
    let total_steps = explicit_steps(&input);
    let system_count = infer_system_count(&input);
    let file_name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("input");
    let parent_name = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
        .unwrap_or(&category);
    let title = if matches!(file_name, "input" | "input_torch") {
        display_name(parent_name)
    } else {
        format!(
            "{} · {}",
            display_name(parent_name),
            display_name(file_name)
        )
    };
    let lowered = file_name.to_ascii_lowercase();
    let suggested_backend = if lowered.contains("jax") {
        Some("jax".into())
    } else if lowered.contains("torch") || lowered.contains("dpa") {
        Some("pytorch".into())
    } else {
        None
    };
    Ok(Some(ExampleEntry {
        id: path_text.clone(),
        path: path_text,
        title,
        category: display_name(&category),
        model_type,
        loss_types,
        total_steps,
        system_count,
        suggested_backend,
        description: nearest_description(root, path.parent().unwrap_or(root)),
    }))
}

fn infer_model_type(input: &Value) -> String {
    let model = &input["model"];
    if model.get("model_dict").is_some() {
        return "Multi-task".into();
    }
    let model_type = model
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("standard");
    if model_type == "standard" {
        model
            .get("descriptor")
            .and_then(|descriptor| descriptor.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("standard")
            .to_owned()
    } else {
        model_type.to_owned()
    }
}

fn infer_loss_types(input: &Value) -> Vec<String> {
    let mut losses = BTreeSet::new();
    if let Some(loss_type) = input
        .get("loss")
        .and_then(|loss| loss.get("type"))
        .and_then(Value::as_str)
    {
        losses.insert(loss_type.to_owned());
    }
    if let Some(loss_dict) = input.get("loss_dict").and_then(Value::as_object) {
        for loss in loss_dict.values() {
            losses.insert(
                loss.get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("ener")
                    .to_owned(),
            );
        }
    }
    if losses.is_empty() {
        losses.insert("ener".into());
    }
    losses.into_iter().collect()
}

fn explicit_steps(input: &Value) -> Option<u64> {
    let training = input.get("training")?;
    [
        "numb_steps",
        "num_steps",
        "num_step",
        "numb_step",
        "stop_batch",
    ]
    .into_iter()
    .find_map(|name| training.get(name).and_then(Value::as_u64))
}

fn infer_system_count(input: &Value) -> usize {
    let systems = input
        .get("training")
        .and_then(|training| training.get("training_data"))
        .and_then(|data| data.get("systems"));
    match systems {
        Some(Value::Array(values)) => values.len(),
        Some(Value::String(value)) if !value.is_empty() => 1,
        _ => 0,
    }
}

fn nearest_description(root: &Path, start: &Path) -> Option<String> {
    let mut directory = start;
    while directory.starts_with(root) {
        let readme = directory.join("README.md");
        if let Ok(text) = fs::read_to_string(readme) {
            let paragraph = text
                .split("\n\n")
                .map(|part| part.lines().map(str::trim).collect::<Vec<_>>().join(" "))
                .find(|part| {
                    let clean = part.trim();
                    !clean.is_empty()
                        && !clean.starts_with('#')
                        && !clean.starts_with("![")
                        && !clean.starts_with("```")
                });
            if paragraph.is_some() {
                return paragraph;
            }
        }
        let Some(parent) = directory.parent() else {
            break;
        };
        directory = parent;
    }
    None
}

fn safe_example_path(root: &Path, relative_path: &str) -> Result<PathBuf> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(anyhow!("invalid example path"));
    }
    let root = root
        .canonicalize()
        .with_context(|| format!("failed to resolve {}", root.display()))?;
    let candidate = root
        .join(relative)
        .canonicalize()
        .with_context(|| format!("failed to resolve example {}", relative.display()))?;
    if !candidate.starts_with(&root) {
        return Err(anyhow!("example path escaped its runtime root"));
    }
    Ok(candidate)
}

fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn display_name(value: &str) -> String {
    value
        .split(['_', '-'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            if part.chars().any(|character| character.is_ascii_digit()) || part.len() <= 4 {
                part.to_ascii_uppercase()
            } else {
                let mut characters = part.chars();
                characters
                    .next()
                    .map(|first| first.to_uppercase().collect::<String>() + characters.as_str())
                    .unwrap_or_default()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn path_to_slashes(path: &Path) -> String {
    path.components()
        .filter_map(component_text)
        .collect::<Vec<_>>()
        .join("/")
}

fn component_text(component: Component<'_>) -> Option<String> {
    match component {
        Component::Normal(value) => value.to_str().map(str::to_owned),
        _ => None,
    }
}

fn sanitize_segment(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn discovers_only_runnable_training_inputs() {
        let temporary = tempdir().expect("temporary examples");
        let directory = temporary.path().join("water").join("dpa4");
        fs::create_dir_all(&directory).expect("create example");
        fs::write(
            directory.join("input.json"),
            r#"{"model":{"type":"standard","descriptor":{"type":"dpa4"}},"loss":{"type":"ener"},"training":{"training_data":{"systems":["../data"]},"numb_steps":1000}}"#,
        )
        .expect("write input");
        fs::write(directory.join("metadata.json"), r#"{"name":"water"}"#).expect("write metadata");

        let catalog = list_examples(temporary.path()).expect("catalog");
        assert_eq!(catalog.entries.len(), 1);
        assert_eq!(catalog.entries[0].path, "water/dpa4/input.json");
        assert_eq!(catalog.entries[0].model_type, "dpa4");
        assert_eq!(catalog.entries[0].total_steps, Some(1000));
    }

    #[test]
    fn rejects_paths_outside_the_examples_root() {
        let temporary = tempdir().expect("temporary examples");
        fs::create_dir_all(temporary.path().join("water")).expect("create examples");
        assert!(read_example_file(temporary.path(), "../secret.json").is_err());
    }
}
