// SPDX-License-Identifier: LGPL-3.0-or-later
//! DeePMD Studio terminal interface and JSONL agent protocol.

use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use chrono::Utc;
use clap::{Args, Parser, Subcommand, ValueEnum};
use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use deepmd_studio_core::{
    ApplicationDownloadResult, CommandRequest, ExampleEntry, ProcessEvent, ProcessEventKind,
    PythonRuntime, ResourceSampler, RuntimeChannel, RuntimeSettings, TrainingContext,
    TrainingSnapshot, build_runtime_arguments, download_application_update, install_runtime,
    list_examples, load_runtime_settings, prepare_example, resolve_application_update,
    resolve_runtime_plan, run_streaming,
};
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::prelude::{Color, Modifier, Style, Stylize};
use ratatui::widgets::{
    Block, Borders, Gauge, List, ListItem, ListState, Paragraph, Sparkline, Wrap,
};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Parser)]
#[command(
    name = "dpstudio",
    version,
    about = "DeePMD Studio TUI and structured agent interface"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Print the complete DeePMD CLI schema.
    Catalog {
        /// Pretty-print JSON instead of compact agent output.
        #[arg(long)]
        pretty: bool,
    },
    /// Inspect Python, backends, and accelerators.
    Doctor {
        /// Pretty-print JSON instead of compact agent output.
        #[arg(long)]
        pretty: bool,
    },
    /// Inspect or rebuild the application-private DeePMD runtime.
    Runtime {
        #[command(subcommand)]
        command: RuntimeCommands,
    },
    /// Check or install the latest DeePMD Studio release.
    SelfUpdate {
        #[command(subcommand)]
        command: SelfUpdateCommands,
    },
    /// Run DeePMD with structured JSONL output or a human console.
    Run {
        /// Canonical DeePMD backend, for example `pytorch` or `jax`.
        #[arg(long)]
        backend: Option<String>,
        /// Child process working directory.
        #[arg(long, default_value = ".")]
        workdir: PathBuf,
        /// Emit one JSON object per lifecycle or output event.
        #[arg(long)]
        jsonl: bool,
        /// DeePMD subcommand followed by its unmodified arguments.
        #[arg(required = true, trailing_var_arg = true)]
        deepmd_args: Vec<String>,
    },
    /// Open the interactive terminal workbench.
    Tui {
        /// Initial backend.
        #[arg(long, default_value = "pytorch")]
        backend: String,
        /// Child process working directory.
        #[arg(long, default_value = ".")]
        workdir: PathBuf,
    },
}

#[derive(Debug, Subcommand)]
enum SelfUpdateCommands {
    /// Resolve the latest release and print the selected platform asset.
    Check {
        /// GitHub URL proxy prefix; pass an empty string to connect directly.
        #[arg(long, default_value = "https://gh-proxy.com")]
        github_proxy: String,
        /// Pretty-print JSON instead of compact agent output.
        #[arg(long)]
        pretty: bool,
    },
    /// Download, verify, and launch the latest platform installer.
    Install {
        /// GitHub URL proxy prefix; pass an empty string to connect directly.
        #[arg(long, default_value = "https://gh-proxy.com")]
        github_proxy: String,
        /// Pretty-print JSON instead of compact agent output.
        #[arg(long)]
        pretty: bool,
    },
}

#[derive(Debug, Subcommand)]
enum RuntimeCommands {
    /// Print the active runtime report and persisted source settings.
    Status {
        /// Pretty-print JSON instead of compact agent output.
        #[arg(long)]
        pretty: bool,
    },
    /// Resolve a channel/ref to an immutable commit without installing it.
    Check {
        #[command(flatten)]
        source: RuntimeSourceArgs,
        /// Pretty-print JSON instead of compact agent output.
        #[arg(long)]
        pretty: bool,
    },
    /// Rebuild, verify, and atomically activate a private runtime.
    Install {
        #[command(flatten)]
        source: RuntimeSourceArgs,
        /// Pretty-print JSON instead of compact agent output.
        #[arg(long)]
        pretty: bool,
    },
}

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
enum RuntimeChannelArg {
    #[default]
    Stable,
    Beta,
    Custom,
}

#[derive(Args, Debug)]
struct RuntimeSourceArgs {
    /// Source policy: latest release tag, latest master, or a custom GitHub ref.
    #[arg(long, value_enum, default_value_t = RuntimeChannelArg::Stable)]
    channel: RuntimeChannelArg,
    /// Custom GitHub repository URL; ignored by stable and beta channels.
    #[arg(long, default_value = "https://github.com/deepmodeling/deepmd-kit.git")]
    repository: String,
    /// Custom branch, tag, or commit; beta always uses master.
    #[arg(long = "ref", default_value = "master")]
    git_ref: String,
    /// Optional GitHub URL proxy prefix, for example https://gh-proxy.com.
    #[arg(long, default_value = "https://gh-proxy.com")]
    github_proxy: String,
}

impl RuntimeSourceArgs {
    fn settings(self) -> RuntimeSettings {
        RuntimeSettings {
            channel: match self.channel {
                RuntimeChannelArg::Stable => RuntimeChannel::Stable,
                RuntimeChannelArg::Beta => RuntimeChannel::Beta,
                RuntimeChannelArg::Custom => RuntimeChannel::Custom,
            },
            repository: self.repository,
            git_ref: self.git_ref,
            github_proxy: self.github_proxy,
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let resource_dir = bundled_resource_dir();
    let runtime = PythonRuntime::isolated(resource_dir.as_deref())?;
    match cli.command.unwrap_or(Commands::Tui {
        backend: "pytorch".into(),
        workdir: PathBuf::from("."),
    }) {
        Commands::Catalog { pretty } => print_json(runtime.bridge("catalog").await?, pretty),
        Commands::Doctor { pretty } => print_json(runtime.bridge("doctor").await?, pretty),
        Commands::Runtime { command } => {
            run_runtime_command(runtime, resource_dir.as_deref(), command).await
        }
        Commands::SelfUpdate { command } => {
            run_self_update(runtime, resource_dir.as_deref(), command).await
        }
        Commands::Run {
            backend,
            workdir,
            jsonl,
            deepmd_args,
        } => run_command(runtime, backend, workdir, deepmd_args, jsonl).await,
        Commands::Tui { backend, workdir } => {
            run_tui(runtime, resource_dir.as_deref(), backend, workdir).await
        }
    }
}

async fn run_self_update(
    runtime: PythonRuntime,
    resource_dir: Option<&std::path::Path>,
    command: SelfUpdateCommands,
) -> Result<()> {
    let manager = runtime_manager_script(resource_dir)?;
    let (github_proxy, pretty, install) = match command {
        SelfUpdateCommands::Check {
            github_proxy,
            pretty,
        } => (github_proxy, pretty, false),
        SelfUpdateCommands::Install {
            github_proxy,
            pretty,
        } => (github_proxy, pretty, true),
    };
    let plan = resolve_application_update(&runtime, &manager, &github_proxy).await?;
    if !install || !plan.update_available {
        return print_json(serde_json::to_value(plan)?, pretty);
    }
    let result = download_application_update(&runtime, &manager, &plan).await?;
    print_json(serde_json::to_value(&result)?, pretty)?;
    launch_application_installer(&result)
}

fn launch_application_installer(result: &ApplicationDownloadResult) -> Result<()> {
    let installer = PathBuf::from(&result.path);
    #[cfg(target_os = "windows")]
    StdCommand::new(installer).spawn()?;
    #[cfg(target_os = "macos")]
    StdCommand::new("open").arg(installer).spawn()?;
    #[cfg(target_os = "linux")]
    StdCommand::new("xdg-open").arg(installer).spawn()?;
    Ok(())
}

async fn run_runtime_command(
    runtime: PythonRuntime,
    resource_dir: Option<&std::path::Path>,
    command: RuntimeCommands,
) -> Result<()> {
    match command {
        RuntimeCommands::Status { pretty } => {
            let report = runtime.bridge("doctor").await?;
            let payload = serde_json::json!({
                "settings": load_runtime_settings()?,
                "runtime": report,
            });
            print_json(payload, pretty)
        }
        RuntimeCommands::Check { source, pretty } => {
            let manager = runtime_manager_script(resource_dir)?;
            let plan = resolve_runtime_plan(&runtime, &manager, &source.settings()).await?;
            print_json(serde_json::to_value(plan)?, pretty)
        }
        RuntimeCommands::Install { source, pretty } => {
            let manager = runtime_manager_script(resource_dir)?;
            let result = install_runtime(&runtime, &manager, &source.settings()).await?;
            print_json(serde_json::to_value(result)?, pretty)
        }
    }
}

fn runtime_manager_script(resource_dir: Option<&std::path::Path>) -> Result<PathBuf> {
    let root = resource_dir.context("DeePMD Studio resource directory is unavailable")?;
    let script = root.join("runtime-manager").join("runtime_manager.py");
    if script.is_file() {
        return Ok(script);
    }
    #[cfg(debug_assertions)]
    {
        let source_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("scripts")
            .join("runtime_manager.py");
        if source_script.is_file() {
            return Ok(source_script);
        }
    }
    Err(anyhow!(
        "runtime manager resource is missing: {}",
        script.display()
    ))
}

fn print_json(value: Value, pretty: bool) -> Result<()> {
    if pretty {
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else {
        println!("{}", serde_json::to_string(&value)?);
    }
    Ok(())
}

async fn run_command(
    runtime: PythonRuntime,
    backend: Option<String>,
    workdir: PathBuf,
    mut deepmd_args: Vec<String>,
    jsonl: bool,
) -> Result<()> {
    let command = deepmd_args
        .first()
        .cloned()
        .ok_or_else(|| anyhow!("a DeePMD subcommand is required"))?;
    deepmd_args.remove(0);
    let request = CommandRequest {
        backend,
        command,
        args: deepmd_args,
        working_directory: workdir,
        environment: Default::default(),
        label: None,
        training: None,
    };
    let task_id = Uuid::new_v4();
    let cancellation = CancellationToken::new();
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let process = tokio::spawn(run_streaming(
        runtime,
        request,
        task_id,
        sender,
        cancellation,
    ));
    let mut exit_code = 1;
    while let Some(process_event) = receiver.recv().await {
        if jsonl {
            println!("{}", serde_json::to_string(&process_event)?);
        } else if let Some(message) = &process_event.message {
            match process_event.kind {
                ProcessEventKind::Stderr | ProcessEventKind::Error => {
                    eprintln!("{message}")
                }
                _ => println!("{message}"),
            }
        }
        if process_event.kind == ProcessEventKind::Finished {
            exit_code = process_event.exit_code.unwrap_or(1);
        }
    }
    let process_result = match process.await {
        Ok(result) => result,
        Err(error) => Err(anyhow!("DeePMD process task panicked: {error}")),
    };
    if let Err(error) = process_result {
        let event = ProcessEvent {
            task_id,
            kind: ProcessEventKind::Error,
            timestamp: Utc::now(),
            message: Some(format!("{error:#}")),
            pid: None,
            exit_code: None,
            cancelled: false,
        };
        if jsonl {
            println!("{}", serde_json::to_string(&event)?);
        } else {
            eprintln!(
                "{}",
                event.message.as_deref().unwrap_or("DeePMD process failed")
            );
        }
        return Err(error);
    }
    if exit_code != 0 {
        return Err(anyhow!("DeePMD exited with code {exit_code}"));
    }
    Ok(())
}

#[derive(Clone, Debug)]
struct Workflow {
    name: String,
    title: String,
    category: String,
    description: String,
    usage: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TuiSection {
    Workflows,
    Examples,
}

struct TuiApp {
    workflows: Vec<Workflow>,
    examples: Vec<ExampleEntry>,
    examples_root: PathBuf,
    workflow_state: ListState,
    example_state: ListState,
    section: TuiSection,
    backend: String,
    workdir: PathBuf,
    arguments: String,
    editing: bool,
    status: String,
}

impl TuiApp {
    fn new(
        workflows: Vec<Workflow>,
        examples: Vec<ExampleEntry>,
        examples_root: PathBuf,
        backend: String,
        workdir: PathBuf,
    ) -> Self {
        let mut workflow_state = ListState::default();
        if !workflows.is_empty() {
            workflow_state.select(Some(0));
        }
        let mut example_state = ListState::default();
        if !examples.is_empty() {
            example_state.select(Some(0));
        }
        Self {
            workflows,
            examples,
            examples_root,
            workflow_state,
            example_state,
            section: TuiSection::Workflows,
            backend,
            workdir,
            arguments: String::new(),
            editing: false,
            status: "Tab switch  |  Up/Down browse  |  e edit  |  r run  |  q quit".into(),
        }
    }

    fn selected_workflow(&self) -> Option<&Workflow> {
        self.workflow_state
            .selected()
            .and_then(|index| self.workflows.get(index))
    }

    fn selected_example(&self) -> Option<&ExampleEntry> {
        self.example_state
            .selected()
            .and_then(|index| self.examples.get(index))
    }

    fn toggle_section(&mut self) {
        self.section = match self.section {
            TuiSection::Workflows => TuiSection::Examples,
            TuiSection::Examples => TuiSection::Workflows,
        };
        self.editing = false;
    }

    fn select_offset(&mut self, delta: isize) {
        let (length, state) = match self.section {
            TuiSection::Workflows => (self.workflows.len(), &mut self.workflow_state),
            TuiSection::Examples => (self.examples.len(), &mut self.example_state),
        };
        if length == 0 {
            return;
        }
        let current = state.selected().unwrap_or(0) as isize;
        let last = length as isize - 1;
        state.select(Some((current + delta).clamp(0, last) as usize));
    }
}

async fn run_tui(
    runtime: PythonRuntime,
    resource_dir: Option<&std::path::Path>,
    backend: String,
    workdir: PathBuf,
) -> Result<()> {
    let catalog = runtime.bridge("catalog").await?;
    let workflows = catalog["commands"]
        .as_array()
        .context("catalog commands are missing")?
        .iter()
        .map(|item| Workflow {
            name: item["name"].as_str().unwrap_or_default().into(),
            title: item["title"].as_str().unwrap_or_default().into(),
            category: item["category"].as_str().unwrap_or_default().into(),
            description: item["description"].as_str().unwrap_or_default().into(),
            usage: item["usage"].as_str().unwrap_or_default().into(),
        })
        .collect();
    let examples_root = active_examples_root(&runtime, resource_dir);
    let examples = list_examples(&examples_root)?.entries;
    let mut app = TuiApp::new(workflows, examples, examples_root.clone(), backend, workdir);
    loop {
        let action = run_tui_session(&mut app)?;
        match action {
            TuiAction::Quit => return Ok(()),
            TuiAction::RunWorkflow => {
                let Some(workflow) = app.selected_workflow().cloned() else {
                    continue;
                };
                let arguments = shell_words::split(&app.arguments)
                    .context("could not parse the argument line")?;
                let training = if workflow.name == "train" {
                    training_context_from_input(&runtime, &app.workdir, &arguments).await
                } else {
                    None
                };
                let request = CommandRequest {
                    backend: Some(app.backend.clone()),
                    command: workflow.name.clone(),
                    args: arguments,
                    working_directory: app.workdir.clone(),
                    environment: Default::default(),
                    label: Some(workflow.title),
                    training,
                };
                if request.command == "train" {
                    run_training_tui(runtime.clone(), request).await?;
                } else {
                    run_request_in_console(runtime.clone(), request).await?;
                }
            }
            TuiAction::RunExample => {
                let Some(example) = app.selected_example().cloned() else {
                    continue;
                };
                let prepared = prepare_example(&examples_root, &example.id)?;
                let request = CommandRequest {
                    backend: Some(app.backend.clone()),
                    command: "train".into(),
                    args: vec![
                        prepared.input_path.display().to_string(),
                        "--skip-neighbor-stat".into(),
                    ],
                    working_directory: prepared.working_directory,
                    environment: Default::default(),
                    label: Some(format!("Example · {}", example.title)),
                    training: Some(TrainingContext {
                        input_path: Some(prepared.input_path),
                        total_steps: example.total_steps,
                        model_type: Some(example.model_type),
                        loss_types: example.loss_types,
                    }),
                };
                run_training_tui(runtime.clone(), request).await?;
            }
        }
    }
}

fn active_examples_root(
    runtime: &PythonRuntime,
    resource_dir: Option<&std::path::Path>,
) -> PathBuf {
    let active = runtime.prefix().join("deepmd-ui-examples");
    if active.is_dir() {
        return active;
    }
    resource_dir
        .map(|root| root.join("runtime").join("deepmd-ui-examples"))
        .unwrap_or(active)
}

enum TuiAction {
    Quit,
    RunWorkflow,
    RunExample,
}

fn run_tui_session(app: &mut TuiApp) -> Result<TuiAction> {
    let mut terminal = ratatui::init();
    let result = (|| {
        loop {
            terminal.draw(|frame| render_tui(frame, app))?;
            if !event::poll(Duration::from_millis(200))? {
                continue;
            }
            let Event::Key(key) = event::read()? else {
                continue;
            };
            if key.kind != KeyEventKind::Press {
                continue;
            }
            if app.editing {
                match key.code {
                    KeyCode::Esc | KeyCode::Enter => app.editing = false,
                    KeyCode::Backspace => {
                        app.arguments.pop();
                    }
                    KeyCode::Char(character) => app.arguments.push(character),
                    _ => {}
                }
                continue;
            }
            match key.code {
                KeyCode::Char('q') | KeyCode::Esc => return Ok(TuiAction::Quit),
                KeyCode::Up | KeyCode::Char('k') => app.select_offset(-1),
                KeyCode::Down | KeyCode::Char('j') => app.select_offset(1),
                KeyCode::Tab => app.toggle_section(),
                KeyCode::Char('1') => app.section = TuiSection::Workflows,
                KeyCode::Char('2') => app.section = TuiSection::Examples,
                KeyCode::Char('e') if app.section == TuiSection::Workflows => app.editing = true,
                KeyCode::Char('r') | KeyCode::Enter => {
                    return Ok(match app.section {
                        TuiSection::Workflows => TuiAction::RunWorkflow,
                        TuiSection::Examples => TuiAction::RunExample,
                    });
                }
                _ => {}
            }
        }
    })();
    ratatui::restore();
    result
}

fn render_tui(frame: &mut ratatui::Frame<'_>, app: &mut TuiApp) {
    let area = frame.area();
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(10),
            Constraint::Length(3),
            Constraint::Length(1),
        ])
        .split(area);
    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(34), Constraint::Percentage(66)])
        .split(rows[1]);
    let header = Paragraph::new(format!(
        " DeePMD Studio  •  [1] Workflows  [2] Examples  •  backend {}  •  {}",
        app.backend,
        app.workdir.display()
    ))
    .bold()
    .block(Block::default().borders(Borders::BOTTOM));
    frame.render_widget(header, rows[0]);
    let items: Vec<ListItem<'_>> = match app.section {
        TuiSection::Workflows => app
            .workflows
            .iter()
            .map(|workflow| ListItem::new(format!("{}  ·  {}", workflow.title, workflow.category)))
            .collect(),
        TuiSection::Examples => app
            .examples
            .iter()
            .map(|example| ListItem::new(example.path.replace('/', " / ")))
            .collect(),
    };
    let list = List::new(items)
        .block(Block::bordered().title(match app.section {
            TuiSection::Workflows => " Workflows ",
            TuiSection::Examples => " Examples ",
        }))
        .highlight_style(
            Style::default()
                .fg(Color::Rgb(184, 162, 255))
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("› ");
    match app.section {
        TuiSection::Workflows => {
            frame.render_stateful_widget(list, columns[0], &mut app.workflow_state)
        }
        TuiSection::Examples => {
            frame.render_stateful_widget(list, columns[0], &mut app.example_state)
        }
    }
    let detail = match app.section {
        TuiSection::Workflows => app
            .selected_workflow()
            .map(|workflow| {
                format!(
                    "{}\n\n{}\n\n{}",
                    workflow.title, workflow.description, workflow.usage
                )
            })
            .unwrap_or_else(|| "No workflow available".into()),
        TuiSection::Examples => app
            .selected_example()
            .map(|example| {
                let source_directory = Path::new(&example.path)
                    .parent()
                    .map(|parent| app.examples_root.join(parent))
                    .unwrap_or_else(|| app.examples_root.clone());
                format!(
                    "{}\n\nModel: {}\nLoss: {}\nSteps: {}\nSystems: {}\nSource: {}\n\n{}\n\nA private writable copy is created before training.",
                    example.title,
                    example.model_type,
                    example.loss_types.join(", "),
                    example
                        .total_steps
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "adaptive".into()),
                    example.system_count,
                    source_directory.display(),
                    example
                        .description
                        .as_deref()
                        .unwrap_or("Runnable input shipped with the active DeePMD runtime."),
                )
            })
            .unwrap_or_else(|| "No bundled examples are available".into()),
    };
    frame.render_widget(
        Paragraph::new(detail)
            .wrap(Wrap { trim: false })
            .block(Block::bordered().title(match app.section {
                TuiSection::Workflows => " Command ",
                TuiSection::Examples => " Training input ",
            })),
        columns[1],
    );
    let input_style = if app.editing {
        Style::default().fg(Color::Rgb(184, 162, 255))
    } else {
        Style::default()
    };
    frame.render_widget(
        Paragraph::new(if app.section == TuiSection::Examples {
            "Press r to copy and run this example with the shared training monitor"
        } else {
            app.arguments.as_str()
        })
        .style(input_style)
        .block(Block::bordered().title(" Arguments ")),
        rows[2],
    );
    frame.render_widget(Paragraph::new(app.status.as_str()).dim(), rows[3]);
}

async fn training_context_from_input(
    runtime: &PythonRuntime,
    workdir: &Path,
    arguments: &[String],
) -> Option<TrainingContext> {
    let raw_input = arguments.first()?.to_owned();
    let mut input_path = PathBuf::from(raw_input);
    if input_path.is_relative() {
        input_path = workdir.join(input_path);
    }
    let response = runtime
        .bridge_with_payload("validate-input", &serde_json::json!({"path": input_path}))
        .await
        .ok();
    let summary = response.as_ref().and_then(|value| value.get("summary"));
    Some(TrainingContext {
        input_path: Some(input_path),
        total_steps: summary
            .and_then(|value| value.get("steps"))
            .and_then(Value::as_u64),
        model_type: summary
            .and_then(|value| value.get("model"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        loss_types: summary
            .and_then(|value| value.get("loss_types"))
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

async fn run_request_in_console(runtime: PythonRuntime, request: CommandRequest) -> Result<()> {
    println!(
        "\n$ {} {}",
        runtime.executable().display(),
        build_runtime_arguments(&runtime, &request).join(" ")
    );
    let mut args = vec![request.command.clone()];
    args.extend(request.args.clone());
    if let Err(error) = run_command(
        runtime,
        request.backend,
        request.working_directory,
        args,
        false,
    )
    .await
    {
        eprintln!("{error:#}");
    }
    print!("\nPress Enter to return to DeePMD Studio...");
    io::stdout().flush()?;
    let mut input = String::new();
    io::stdin().read_line(&mut input)?;
    Ok(())
}

async fn run_training_tui(runtime: PythonRuntime, request: CommandRequest) -> Result<()> {
    let task_id = Uuid::new_v4();
    let cancellation = CancellationToken::new();
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let process = tokio::spawn(run_streaming(
        runtime,
        request.clone(),
        task_id,
        sender,
        cancellation.clone(),
    ));
    let mut training = TrainingSnapshot::new(request.training.clone().unwrap_or_default());
    let mut logs = Vec::new();
    let mut sampler = ResourceSampler::new();
    let mut pid = None;
    let mut finished = false;
    let mut exit_code = None;
    let mut cancelled = false;
    let started = Instant::now();
    let mut last_sample = Instant::now() - Duration::from_secs(2);
    let mut terminal = ratatui::init();

    let ui_result = async {
        loop {
            while let Ok(process_event) = receiver.try_recv() {
                if let Some(message) = process_event.message {
                    training.apply_log_line(&message);
                    logs.push(message);
                    if logs.len() > 1_000 {
                        logs.drain(..logs.len() - 1_000);
                    }
                }
                if process_event.kind == ProcessEventKind::Started {
                    pid = process_event.pid;
                }
                if process_event.kind == ProcessEventKind::Finished {
                    finished = true;
                    cancelled = process_event.cancelled;
                    exit_code = process_event.exit_code;
                }
            }
            if let Some(process_id) = pid.filter(|_| !finished)
                && last_sample.elapsed() >= Duration::from_millis(1_200)
            {
                training.push_resource(sampler.sample(process_id).await);
                last_sample = Instant::now();
            }
            terminal.draw(|frame| {
                render_training_tui(
                    frame,
                    &request,
                    &training,
                    &logs,
                    started.elapsed(),
                    finished,
                    cancelled,
                    exit_code,
                )
            })?;

            if event::poll(Duration::from_millis(80))?
                && let Event::Key(key) = event::read()?
                && key.kind == KeyEventKind::Press
            {
                if finished
                    && matches!(key.code, KeyCode::Enter | KeyCode::Esc | KeyCode::Char('q'))
                {
                    break;
                }
                if !finished
                    && matches!(
                        key.code,
                        KeyCode::Esc | KeyCode::Char('q') | KeyCode::Char('c')
                    )
                {
                    cancellation.cancel();
                    cancelled = true;
                }
            }
            if process.is_finished() && receiver.is_closed() && !finished {
                finished = true;
            }
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;
    ratatui::restore();
    ui_result?;
    match process.await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) => Err(error),
        Err(error) => Err(anyhow!("training worker failed: {error}")),
    }
}

#[allow(clippy::too_many_arguments)]
fn render_training_tui(
    frame: &mut ratatui::Frame<'_>,
    request: &CommandRequest,
    training: &TrainingSnapshot,
    logs: &[String],
    elapsed: Duration,
    finished: bool,
    cancelled: bool,
    exit_code: Option<i32>,
) {
    let rows = Layout::vertical([
        Constraint::Length(3),
        Constraint::Length(3),
        Constraint::Min(14),
        Constraint::Length(1),
    ])
    .split(frame.area());
    let title = request.label.as_deref().unwrap_or("DeePMD training");
    let state = if !finished {
        "RUNNING".fg(Color::Rgb(102, 209, 154))
    } else if cancelled {
        "CANCELLED".fg(Color::Rgb(241, 137, 137))
    } else if exit_code == Some(0) {
        "COMPLETED".fg(Color::Rgb(102, 209, 154))
    } else {
        "FAILED".fg(Color::Rgb(241, 137, 137))
    };
    frame.render_widget(
        Paragraph::new(format!(
            " DeePMD Studio  •  {}  •  {}  •  {:.0}s\n Directory: {}",
            title,
            state.content,
            elapsed.as_secs_f64(),
            request.working_directory.display()
        ))
        .bold()
        .block(Block::default().borders(Borders::BOTTOM)),
        rows[0],
    );
    let total = training.context.total_steps;
    let ratio = total
        .map(|value| training.current_step as f64 / value.max(1) as f64)
        .unwrap_or(0.0)
        .clamp(0.0, 1.0);
    let progress_label = total.map_or_else(
        || format!("{} steps", training.current_step),
        |value| {
            format!(
                "{:.1}%  •  {} / {} steps",
                ratio * 100.0,
                training.current_step,
                value
            )
        },
    );
    frame.render_widget(
        Gauge::default()
            .block(Block::bordered().title(" Training progress "))
            .gauge_style(Style::default().fg(Color::Rgb(153, 124, 241)))
            .ratio(ratio)
            .label(progress_label),
        rows[1],
    );

    let columns =
        Layout::horizontal([Constraint::Percentage(34), Constraint::Percentage(66)]).split(rows[2]);
    render_training_resources(frame, columns[0], training);
    let right = Layout::vertical([Constraint::Percentage(72), Constraint::Percentage(28)])
        .split(columns[1]);
    render_training_metrics(frame, right[0], training);
    let log_height = right[1].height.saturating_sub(2) as usize;
    let log_text = logs
        .iter()
        .rev()
        .take(log_height)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    frame.render_widget(
        Paragraph::new(log_text)
            .wrap(Wrap { trim: false })
            .block(Block::bordered().title(" Process output ")),
        right[1],
    );
    let footer = if finished {
        "Enter/Esc return  •  training history remains in the GUI Tasks view"
    } else {
        "c/q stop training  •  metrics are discovered dynamically from the active loss"
    };
    frame.render_widget(Paragraph::new(footer).dim(), rows[3]);
}

fn render_training_resources(
    frame: &mut ratatui::Frame<'_>,
    area: ratatui::layout::Rect,
    training: &TrainingSnapshot,
) {
    let rows = Layout::vertical([
        Constraint::Length(6),
        Constraint::Length(3),
        Constraint::Length(3),
        Constraint::Length(3),
        Constraint::Min(3),
    ])
    .split(area);
    let resource = training.resources.last();
    let gpu = resource.and_then(|value| value.gpus.first());
    frame.render_widget(
        Paragraph::new(format!(
            "Model  {}\nLoss   {}\nETA    {}\nStep   {}",
            training
                .context
                .model_type
                .as_deref()
                .unwrap_or("detecting"),
            if training.context.loss_types.is_empty() {
                "detecting".into()
            } else {
                training.context.loss_types.join(", ")
            },
            training
                .eta_seconds
                .map(|value| format!("{}m {}s", value / 60, value % 60))
                .unwrap_or_else(|| "estimating".into()),
            training
                .step_time_seconds
                .map(|value| format!("{value:.4} s"))
                .unwrap_or_else(|| "measuring".into()),
        ))
        .block(Block::bordered().title(" Run summary ")),
        rows[0],
    );
    frame.render_widget(
        Gauge::default()
            .block(Block::bordered().title(" CPU "))
            .gauge_style(Style::default().fg(Color::Rgb(153, 124, 241)))
            .ratio(resource.map_or(0.0, |value| value.cpu_percent as f64 / 100.0))
            .label(resource.map_or_else(
                || "waiting".into(),
                |value| format!("{:.1}%", value.cpu_percent),
            )),
        rows[1],
    );
    frame.render_widget(
        Gauge::default()
            .block(Block::bordered().title(" GPU "))
            .gauge_style(Style::default().fg(Color::Rgb(32, 184, 205)))
            .ratio(gpu.map_or(0.0, |value| value.utilization_percent as f64 / 100.0))
            .label(gpu.map_or_else(
                || "CPU / Metal / waiting".into(),
                |value| format!("{:.0}%  {}", value.utilization_percent, value.name),
            )),
        rows[2],
    );
    let memory_ratio = resource.map_or(0.0, |value| {
        value.system_memory_used_bytes as f64 / value.system_memory_total_bytes.max(1) as f64
    });
    frame.render_widget(
        Gauge::default()
            .block(Block::bordered().title(" System RAM "))
            .gauge_style(Style::default().fg(Color::Rgb(243, 154, 85)))
            .ratio(memory_ratio.clamp(0.0, 1.0))
            .label(resource.map_or_else(
                || "waiting".into(),
                |value| {
                    format!(
                        "process {:.1} GB",
                        value.process_memory_bytes as f64 / 1024_f64.powi(3)
                    )
                },
            )),
        rows[3],
    );
    frame.render_widget(
        Paragraph::new(gpu.map_or_else(
            || "No NVIDIA telemetry. CPU and RAM monitoring remain active.".into(),
            |value| {
                format!(
                    "GPU memory {:.1}/{:.1} GB\nTemperature {} °C",
                    value.memory_used_bytes as f64 / 1024_f64.powi(3),
                    value.memory_total_bytes as f64 / 1024_f64.powi(3),
                    value
                        .temperature_celsius
                        .map(|temperature| format!("{temperature:.0}"))
                        .unwrap_or_else(|| "—".into())
                )
            },
        ))
        .wrap(Wrap { trim: false })
        .block(Block::bordered().title(" Accelerator ")),
        rows[4],
    );
}

fn render_training_metrics(
    frame: &mut ratatui::Frame<'_>,
    area: ratatui::layout::Rect,
    training: &TrainingSnapshot,
) {
    let series = collect_metric_series(training);
    if series.is_empty() {
        frame.render_widget(
            Paragraph::new("Waiting for the first reported training step…")
                .block(Block::bordered().title(" Loss & validation ")),
            area,
        );
        return;
    }
    let maximum = usize::from(area.height.saturating_sub(2) / 3).max(1);
    let visible = series.into_iter().take(maximum).collect::<Vec<_>>();
    let constraints = visible
        .iter()
        .map(|_| Constraint::Length(3))
        .collect::<Vec<_>>();
    let rows = Layout::vertical(constraints).split(area);
    for ((name, values), row) in visible.into_iter().zip(rows.iter()) {
        let data = normalized_sparkline(&values);
        let latest = values.last().copied().unwrap_or_default();
        frame.render_widget(
            Sparkline::default()
                .block(Block::bordered().title(format!(" {name}  latest {latest:.2e} ")))
                .style(Style::default().fg(Color::Rgb(153, 124, 241)))
                .data(&data),
            *row,
        );
    }
}

fn collect_metric_series(training: &TrainingSnapshot) -> Vec<(String, Vec<f64>)> {
    let mut rows: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for sample in &training.metrics {
        for (metric, value) in &sample.values {
            let (display_value, unit) = metric_display(metric, *value);
            let name = format!(
                "{}{} · {}{}",
                sample
                    .task
                    .as_ref()
                    .map(|task| format!("{task} · "))
                    .unwrap_or_default(),
                sample.phase,
                metric,
                unit.map(|value| format!(" [{value}]")).unwrap_or_default(),
            );
            rows.entry(name).or_default().push(display_value);
        }
    }
    rows.into_iter().collect()
}

fn metric_display(metric: &str, value: f64) -> (f64, Option<&'static str>) {
    let metric = metric.to_ascii_lowercase();
    if !(metric.starts_with("rmse_") || metric.starts_with("mae_")) {
        return (value, None);
    }
    let unit = if metric.ends_with("force_m") || metric.ends_with("_fm") {
        Some("meV/μB")
    } else if metric.ends_with("hessian") || metric.ends_with("_h") {
        Some("meV/Å²")
    } else if metric.ends_with("force")
        || metric.ends_with("_f")
        || metric.ends_with("_fr")
        || metric.ends_with("_pf")
        || metric.ends_with("_gf")
    {
        Some("meV/Å")
    } else if metric.ends_with("atom_ener")
        || metric.ends_with("atomic_energy")
        || metric.ends_with("_ae")
    {
        Some("meV")
    } else if metric.ends_with("virial") || metric.ends_with("_v") {
        Some("meV/atom")
    } else if metric.ends_with("ener") || metric.ends_with("_e") || metric.ends_with("_ea") {
        Some("meV/atom")
    } else {
        None
    };
    unit.map_or((value, None), |unit| (value * 1_000.0, Some(unit)))
}

fn normalized_sparkline(values: &[f64]) -> Vec<u64> {
    let logs = values
        .iter()
        .filter(|value| value.is_finite() && **value > 0.0)
        .map(|value| value.log10())
        .collect::<Vec<_>>();
    if logs.is_empty() {
        return vec![0];
    }
    let minimum = logs.iter().copied().fold(f64::INFINITY, f64::min);
    let maximum = logs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    logs.into_iter()
        .map(|value| (((value - minimum) / (maximum - minimum).max(0.01)) * 100.0) as u64)
        .collect()
}

fn bundled_resource_dir() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("DPMD_STUDIO_RESOURCE_DIR") {
        let candidate = PathBuf::from(path);
        if candidate.join("runtime").is_dir() {
            return Some(candidate);
        }
    }

    let executable = std::env::current_exe().ok()?;
    let executable_dir = executable.parent()?;
    let mut candidates = vec![
        executable_dir.to_path_buf(),
        executable_dir.join("resources"),
    ];
    if let Some(contents) = executable_dir.parent() {
        candidates.push(contents.join("Resources"));
    }
    if let Some(app_dir) = std::env::var_os("APPDIR") {
        let app_dir = PathBuf::from(app_dir);
        candidates.extend([
            app_dir.join("usr/lib/deepmd-studio"),
            app_dir.join("usr/lib/org.deepmodeling.deepmd-studio"),
        ]);
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.join("runtime").is_dir())
}
