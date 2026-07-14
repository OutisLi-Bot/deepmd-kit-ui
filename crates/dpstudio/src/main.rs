// SPDX-License-Identifier: LGPL-3.0-or-later
//! DeePMD Studio terminal interface and JSONL agent protocol.

use std::io::{self, Write};
use std::path::PathBuf;
use std::process::Command as StdCommand;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use chrono::Utc;
use clap::{Args, Parser, Subcommand, ValueEnum};
use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use deepmd_studio_core::{
    ApplicationDownloadResult, CommandRequest, ProcessEvent, ProcessEventKind, PythonRuntime,
    RuntimeChannel, RuntimeSettings, build_runtime_arguments, download_application_update,
    install_runtime, load_runtime_settings, resolve_application_update, resolve_runtime_plan,
    run_streaming,
};
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::prelude::{Color, Modifier, Style, Stylize};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap};
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
        Commands::Tui { backend, workdir } => run_tui(runtime, backend, workdir).await,
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

struct TuiApp {
    workflows: Vec<Workflow>,
    list_state: ListState,
    backend: String,
    workdir: PathBuf,
    arguments: String,
    editing: bool,
    status: String,
}

impl TuiApp {
    fn new(workflows: Vec<Workflow>, backend: String, workdir: PathBuf) -> Self {
        let mut list_state = ListState::default();
        if !workflows.is_empty() {
            list_state.select(Some(0));
        }
        Self {
            workflows,
            list_state,
            backend,
            workdir,
            arguments: String::new(),
            editing: false,
            status: "Up/Down browse  |  e edit arguments  |  r run  |  q quit".into(),
        }
    }

    fn selected(&self) -> Option<&Workflow> {
        self.list_state
            .selected()
            .and_then(|index| self.workflows.get(index))
    }

    fn select_offset(&mut self, delta: isize) {
        if self.workflows.is_empty() {
            return;
        }
        let current = self.list_state.selected().unwrap_or(0) as isize;
        let last = self.workflows.len() as isize - 1;
        self.list_state
            .select(Some((current + delta).clamp(0, last) as usize));
    }
}

async fn run_tui(runtime: PythonRuntime, backend: String, workdir: PathBuf) -> Result<()> {
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
    let mut app = TuiApp::new(workflows, backend, workdir);
    loop {
        let action = run_tui_session(&mut app)?;
        match action {
            TuiAction::Quit => return Ok(()),
            TuiAction::Run => {
                let Some(workflow) = app.selected().cloned() else {
                    continue;
                };
                let arguments = shell_words::split(&app.arguments)
                    .context("could not parse the argument line")?;
                let request = CommandRequest {
                    backend: Some(app.backend.clone()),
                    command: workflow.name,
                    args: arguments,
                    working_directory: app.workdir.clone(),
                    environment: Default::default(),
                    label: Some(workflow.title),
                };
                println!(
                    "\n$ {} {}",
                    runtime.executable().display(),
                    build_runtime_arguments(&runtime, &request).join(" ")
                );
                println!("TUI execution hands control to the structured runner.\n");
                let mut args = vec![request.command.clone()];
                args.extend(request.args.clone());
                let result = run_command(
                    runtime.clone(),
                    request.backend.clone(),
                    request.working_directory.clone(),
                    args,
                    false,
                )
                .await;
                if let Err(error) = result {
                    eprintln!("{error:#}");
                }
                print!("\nPress Enter to return to DeePMD Studio...");
                io::stdout().flush()?;
                let mut input = String::new();
                io::stdin().read_line(&mut input)?;
            }
        }
    }
}

enum TuiAction {
    Quit,
    Run,
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
                KeyCode::Char('e') | KeyCode::Tab => app.editing = true,
                KeyCode::Char('r') | KeyCode::Enter => {
                    return Ok(TuiAction::Run);
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
        " DeePMD Studio  •  backend {}  •  {}",
        app.backend,
        app.workdir.display()
    ))
    .bold()
    .block(Block::default().borders(Borders::BOTTOM));
    frame.render_widget(header, rows[0]);
    let items: Vec<ListItem<'_>> = app
        .workflows
        .iter()
        .map(|workflow| ListItem::new(format!("{}  ·  {}", workflow.title, workflow.category)))
        .collect();
    let list = List::new(items)
        .block(Block::bordered().title(" Workflows "))
        .highlight_style(
            Style::default()
                .fg(Color::Rgb(184, 162, 255))
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("› ");
    frame.render_stateful_widget(list, columns[0], &mut app.list_state);
    let detail = app
        .selected()
        .map(|workflow| {
            format!(
                "{}\n\n{}\n\n{}",
                workflow.title, workflow.description, workflow.usage
            )
        })
        .unwrap_or_else(|| "No workflow available".into());
    frame.render_widget(
        Paragraph::new(detail)
            .wrap(Wrap { trim: false })
            .block(Block::bordered().title(" Command ")),
        columns[1],
    );
    let input_style = if app.editing {
        Style::default().fg(Color::Rgb(184, 162, 255))
    } else {
        Style::default()
    };
    frame.render_widget(
        Paragraph::new(app.arguments.as_str())
            .style(input_style)
            .block(Block::bordered().title(" Arguments ")),
        rows[2],
    );
    frame.render_widget(Paragraph::new(app.status.as_str()).dim(), rows[3]);
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
