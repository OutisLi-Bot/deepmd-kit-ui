// SPDX-License-Identifier: LGPL-3.0-or-later

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";

import type {
  ApplicationDownloadResult,
  ApplicationUpdatePlan,
  CatalogArgument,
  CommandCatalog,
  CommandRequest,
  ProcessEvent,
  RuntimeInstallResult,
  RuntimeLocation,
  RuntimePlan,
  RuntimeReport,
  RuntimeSettings,
  SystemReport,
  TaskSnapshot,
  TrainingInputInspection,
  TrainingInputSchema,
  JsonValue,
  Workflow,
} from "../types";
import { mockTrainingSchema } from "./mockTrainingSchema";

export const isDesktop = typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

const sharedArguments: CatalogArgument[] = [
  {
    id: "log_level",
    flags: ["-v", "--log-level"],
    positional: false,
    required: false,
    kind: "select",
    nargs: null,
    default: "INFO",
    choices: ["DEBUG", "INFO", "WARNING", "ERROR"],
    help: "Set the console and file logging level.",
    metavar: null,
    mutex_group: null,
  },
  {
    id: "log_path",
    flags: ["-l", "--log-path"],
    positional: false,
    required: false,
    kind: "path",
    nargs: null,
    default: null,
    choices: [],
    help: "Write log messages to this file.",
    metavar: null,
    mutex_group: null,
  },
];

function mockWorkflow(
  name: string,
  category: string,
  title: string,
  description: string,
  icon: string,
  accent: string,
  featured = false,
  arguments_: CatalogArgument[] = [],
): Workflow {
  return {
    name,
    category,
    title,
    description,
    icon,
    accent,
    featured,
    usage: `usage: dp ${name} [options]`,
    arguments: [...sharedArguments, ...arguments_],
  };
}

const mockCatalog: CommandCatalog = {
  schema_version: 1,
  deepmd_version: "3.1.4.dev",
  categories: ["Training", "Evaluate", "Models", "Data"],
  backends: [
    { id: "pytorch", aliases: ["pt", "pytorch"], flag: "--pt", available: true },
    { id: "pytorch-exportable", aliases: ["pt-expt"], flag: "--pt-expt", available: true },
    { id: "jax", aliases: ["jax"], flag: "--jax", available: true },
    { id: "dpmodel", aliases: ["dp", "numpy"], flag: "--dp", available: true },
    { id: "tensorflow", aliases: ["tf"], flag: "--tf", available: false },
  ],
  commands: [
    mockWorkflow(
      "train",
      "Training",
      "Train a model",
      "Fit a Deep Potential model from a JSON or YAML configuration.",
      "sparkles",
      "violet",
      true,
      [
        {
          id: "INPUT",
          flags: [],
          positional: true,
          required: true,
          kind: "path",
          nargs: null,
          default: null,
          choices: [],
          help: "The training input file in JSON or YAML format.",
          metavar: null,
          mutex_group: null,
        },
        {
          id: "init_model",
          flags: ["--init-model"],
          positional: false,
          required: false,
          kind: "path",
          nargs: null,
          default: null,
          choices: [],
          help: "Initialize parameters from an existing checkpoint.",
          metavar: null,
          mutex_group: "mutex-0",
        },
        {
          id: "restart",
          flags: ["--restart"],
          positional: false,
          required: false,
          kind: "path",
          nargs: null,
          default: null,
          choices: [],
          help: "Resume training from a checkpoint.",
          metavar: null,
          mutex_group: "mutex-0",
        },
        {
          id: "skip_neighbor_stat",
          flags: ["--skip-neighbor-stat"],
          positional: false,
          required: false,
          kind: "boolean",
          nargs: 0,
          default: false,
          choices: [],
          help: "Skip the initial neighbor-statistics pass.",
          metavar: null,
          mutex_group: null,
        },
      ],
    ),
    mockWorkflow("test", "Evaluate", "Test a model", "Measure model errors on labeled systems.", "flask-conical", "emerald", true),
    mockWorkflow("model-devi", "Evaluate", "Model deviation", "Evaluate uncertainty from an ensemble of models.", "activity", "amber"),
    mockWorkflow("eval-desc", "Evaluate", "Evaluate descriptors", "Inspect descriptor output for systems and atoms.", "scan-search", "cyan"),
    mockWorkflow("embed", "Evaluate", "Model embeddings", "Export descriptors and structural features.", "boxes", "cyan"),
    mockWorkflow("freeze", "Models", "Freeze checkpoint", "Export a checkpoint as a portable inference model.", "snowflake", "blue", true),
    mockWorkflow("show", "Models", "Inspect model", "Show metadata and supported model capabilities.", "info", "slate"),
    mockWorkflow("compress", "Models", "Compress model", "Tabulate eligible networks for faster inference.", "archive-restore", "indigo"),
    mockWorkflow("change-bias", "Models", "Change output bias", "Recalibrate model output bias using a dataset.", "sliders-horizontal", "rose"),
    mockWorkflow("convert-backend", "Models", "Convert backend", "Convert a portable model to another backend.", "repeat-2", "violet"),
    mockWorkflow("pretrained", "Models", "Pretrained models", "Discover and manage pretrained models.", "library", "orange"),
    mockWorkflow("neighbor-stat", "Data", "Neighbor statistics", "Calculate distances and neighbor counts.", "radar", "teal"),
  ],
};

const mockRuntime: RuntimeReport = {
  schema_version: 1,
  deepmd_version: "3.1.4.dev",
  python: {
    version: "3.13.5",
    executable: "C:\\DeePMD Studio\\runtime\\python.exe",
    prefix: "C:\\DeePMD Studio\\runtime",
    bundled: true,
  },
  platform: { system: "Windows", release: "11", machine: "AMD64", node: "workstation" },
  package_root: "C:\\DeePMD Studio\\runtime\\Lib\\site-packages\\deepmd",
  backends: [
    { id: "pytorch", package: "torch", available: true },
    { id: "pytorch-exportable", package: "torch", available: true },
    { id: "jax", package: "jax", available: true },
    { id: "dpmodel", package: "numpy", available: true },
    { id: "tensorflow", package: "tensorflow", available: false },
  ],
  accelerator: {
    kind: "cuda",
    available: true,
    torch_version: "2.12.0",
    cuda_version: "13.0",
    devices: [{ index: 0, name: "NVIDIA GeForce RTX 5090 Laptop GPU", memory_bytes: 25757220864 }],
  },
  triton: {
    available: true,
    driver_ready: true,
    version: "3.7.1",
    distribution: "3.7.1.post27",
  },
};

const mockSystemReport: SystemReport = {
  operatingSystem: {
    name: "Windows",
    version: "Windows 11 Pro 24H2",
    kernel: "10.0.26100",
    hostname: "workstation",
    architecture: "x86_64",
  },
  cpu: {
    brand: "AMD Ryzen AI 9 HX 370",
    vendor: "AuthenticAMD",
    physicalCores: 12,
    logicalCores: 24,
    frequencyMhz: 2000,
  },
  memory: { totalBytes: 64 * 1024 ** 3, availableBytes: 41 * 1024 ** 3 },
  disks: [
    {
      name: "NVMe SSD",
      mountPoint: "C:\\",
      fileSystem: "NTFS",
      kind: "SSD",
      totalBytes: 2 * 1024 ** 4,
      availableBytes: 1.24 * 1024 ** 4,
      removable: false,
    },
  ],
};

let mockRuntimeSettings: RuntimeSettings = {
  channel: "stable",
  repository: "https://github.com/deepmodeling/deepmd-kit.git",
  git_ref: "master",
  github_proxy: "https://gh-proxy.com",
};

let mockTasks: TaskSnapshot[] = [];
const mockListeners = new Set<(event: ProcessEvent) => void>();

function emitMock(event: ProcessEvent): void {
  for (const listener of mockListeners) listener(event);
}

function updateMockTask(id: string, update: Partial<TaskSnapshot>): void {
  mockTasks = mockTasks.map((task) => (task.id === id ? { ...task, ...update } : task));
}

export async function getCatalog(): Promise<CommandCatalog> {
  return isDesktop ? invoke<CommandCatalog>("get_catalog") : mockCatalog;
}

export async function getTrainingSchema(): Promise<TrainingInputSchema> {
  return isDesktop ? invoke<TrainingInputSchema>("get_training_schema") : mockTrainingSchema;
}

function summarizeTrainingInput(input: Record<string, JsonValue>): TrainingInputInspection {
  const model = (input.model ?? {}) as Record<string, JsonValue>;
  const training = (input.training ?? {}) as Record<string, JsonValue>;
  const trainingData = (training.training_data ?? {}) as Record<string, JsonValue>;
  const systems = (trainingData.systems ?? ".") as string | string[];
  const modelType = String(model.type ?? "standard");
  const descriptor = (model.descriptor ?? {}) as Record<string, JsonValue>;
  return {
    valid: Boolean(input.model && input.training && training.training_data),
    error: input.model && input.training && training.training_data ? null : "model and training.training_data are required",
    input,
    summary: {
      model: modelType === "standard" ? String(descriptor.type ?? "standard") : modelType,
      model_type: modelType,
      optimizer: String(((input.optimizer ?? {}) as Record<string, JsonValue>).type ?? "Adam"),
      steps: Number(training.numb_steps ?? 1_000_000),
      systems,
      system_count: Array.isArray(systems) ? systems.length : systems ? 1 : 0,
    },
    source_path: null,
    working_directory: null,
  };
}

export async function inspectTrainingInput(path: string): Promise<TrainingInputInspection> {
  if (isDesktop) return invoke<TrainingInputInspection>("inspect_training_input", { path });
  const result = summarizeTrainingInput({
    model: { type: "dpa4", descriptor: { type: "dpa4" }, fitting_net: { type: "dpa4_ener" } },
    training: { training_data: { systems: ["data\\water"] }, numb_steps: 100_000 },
    optimizer: { type: "AdamW" },
  });
  return { ...result, source_path: path, working_directory: "C:\\Projects\\water-dpa4" };
}

export async function validateTrainingInput(input: Record<string, JsonValue>): Promise<TrainingInputInspection> {
  return isDesktop
    ? invoke<TrainingInputInspection>("validate_training_input", { input })
    : summarizeTrainingInput(input);
}

export async function saveTrainingInput(path: string, input: Record<string, JsonValue>): Promise<string> {
  if (isDesktop) return invoke<string>("save_training_input", { path, input });
  return path.toLowerCase().endsWith(".json") ? path : `${path}.json`;
}

export async function getSystemReport(): Promise<SystemReport> {
  return isDesktop ? invoke<SystemReport>("get_system_report") : mockSystemReport;
}

export async function getRuntimeReport(): Promise<RuntimeReport> {
  return isDesktop ? invoke<RuntimeReport>("get_runtime_report") : mockRuntime;
}

export async function getRuntimeSummary(): Promise<RuntimeReport> {
  if (!isDesktop) return mockRuntime;
  return invoke<RuntimeReport>("get_runtime_summary");
}

export async function getRuntimeLocation(): Promise<RuntimeLocation> {
  if (isDesktop) return invoke<RuntimeLocation>("get_runtime_location");
  return {
    executable: mockRuntime.python.executable,
    source: "bundled",
  };
}

export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  return isDesktop
    ? invoke<RuntimeSettings>("get_runtime_settings")
    : { ...mockRuntimeSettings };
}

export async function setRuntimeSettings(settings: RuntimeSettings): Promise<void> {
  if (isDesktop) {
    await invoke("set_runtime_settings", { settings });
    return;
  }
  mockRuntimeSettings = { ...settings };
}

export async function resolveRuntimeUpdate(settings: RuntimeSettings): Promise<RuntimePlan> {
  if (isDesktop) return invoke<RuntimePlan>("resolve_runtime_update", { settings });
  const commit = settings.channel === "stable"
    ? "cf083b3bc2e0ba3351a004acb6931ef549149672"
    : "6c1a6c8f21ee6ecda0d61fa8d72828ced4c3a692";
  const official = settings.channel !== "custom";
  const requestedRef = settings.channel === "stable" ? "v3.1.0" : settings.channel === "beta" ? "master" : settings.git_ref;
  return {
    schema_version: 1,
    channel: settings.channel,
    repository: official ? "https://github.com/deepmodeling/deepmd-kit.git" : settings.repository,
    repository_slug: official ? "deepmodeling/deepmd-kit" : settings.repository.replace(/^.*github\.com[/:]/, "").replace(/\.git$/, ""),
    requested_ref: requestedRef,
    resolved_ref: requestedRef,
    commit,
    short_commit: commit.slice(0, 12),
    display_version: `${requestedRef}@${commit.slice(0, 12)}`,
    archive_url: `https://github.com/deepmodeling/deepmd-kit/archive/${commit}.zip`,
    github_proxy: settings.github_proxy,
    update_mode: "python_overlay",
  };
}

export async function installRuntimeUpdate(settings: RuntimeSettings): Promise<RuntimeInstallResult> {
  if (isDesktop) return invoke<RuntimeInstallResult>("install_runtime_update", { settings });
  const plan = await resolveRuntimeUpdate(settings);
  await new Promise((resolve) => window.setTimeout(resolve, 900));
  mockRuntimeSettings = { ...settings };
  return {
    schema_version: 1,
    runtime: "C:\\Users\\you\\AppData\\Local\\DeePMD Studio\\runtime",
    plan,
    doctor: mockRuntime,
    restart_required: true,
  };
}

export async function restartApplication(): Promise<void> {
  if (isDesktop) {
    await invoke("restart_application");
    return;
  }
  window.location.reload();
}

export async function checkApplicationUpdate(githubProxy: string): Promise<ApplicationUpdatePlan> {
  if (isDesktop) {
    return invoke<ApplicationUpdatePlan>("check_application_update", { githubProxy });
  }
  return {
    schema_version: 1,
    repository_slug: "OutisLi-Bot/deepmd-kit-ui",
    current_version: "0.1.0",
    latest_version: "0.2.0",
    tag: "v0.2.0",
    update_available: true,
    platform_key: "windows-x86_64",
    asset_name: "DeePMD-Studio-0.2.0-Windows-x64-CUDA13-Setup.exe",
    asset_url: "https://github.com/OutisLi-Bot/deepmd-kit-ui/releases/download/v0.2.0/DeePMD-Studio-0.2.0-Windows-x64-CUDA13-Setup.exe",
    sha256: "3141592653589793238462643383279502884197169399375105820974944592",
    bytes: 1_785_000_000,
    github_proxy: githubProxy,
  };
}

export async function downloadApplicationUpdate(
  plan: ApplicationUpdatePlan,
): Promise<ApplicationDownloadResult> {
  if (isDesktop) {
    return invoke<ApplicationDownloadResult>("download_application_update", { plan });
  }
  await new Promise((resolve) => window.setTimeout(resolve, 900));
  return {
    schema_version: 1,
    path: `C:\\Users\\you\\AppData\\Local\\DeePMD Studio\\updates\\${plan.asset_name}`,
    sha256: plan.sha256,
    bytes: plan.bytes,
    plan,
  };
}

export async function launchApplicationUpdate(installerPath: string): Promise<void> {
  if (isDesktop) {
    await invoke("launch_application_update", { installerPath });
  }
}

export async function getDefaultWorkingDirectory(): Promise<string> {
  return isDesktop ? invoke<string>("get_default_working_directory") : "C:\\Projects\\water-dpa4";
}

export async function startTask(request: CommandRequest): Promise<TaskSnapshot> {
  if (isDesktop) return invoke<TaskSnapshot>("start_task", { request });
  const id = crypto.randomUUID();
  const task: TaskSnapshot = {
    id,
    request,
    status: "queued",
    pid: null,
    exitCode: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    log: [],
  };
  mockTasks = [task, ...mockTasks];
  window.setTimeout(() => {
    updateMockTask(id, { status: "running", pid: 24108 });
    emitMock({ taskId: id, kind: "started", timestamp: new Date().toISOString(), message: null, pid: 24108, exitCode: null, cancelled: false });
  }, 180);
  const lines = [
    "DEEPMD INFO    running on: workstation",
    "DEEPMD INFO    installed to: DeePMD Studio runtime",
    "DEEPMD INFO    training data with 2 systems",
    "DEEPMD INFO    step      100: train_loss = 2.317e-02, lr = 9.998e-04",
    "DEEPMD INFO    step      200: train_loss = 8.424e-03, lr = 9.992e-04",
  ];
  lines.forEach((message, index) => {
    window.setTimeout(() => {
      const current = mockTasks.find((item) => item.id === id);
      updateMockTask(id, { log: [...(current?.log ?? []), message] });
      emitMock({ taskId: id, kind: "stdout", timestamp: new Date().toISOString(), message, pid: null, exitCode: null, cancelled: false });
    }, 500 + index * 360);
  });
  window.setTimeout(() => {
    updateMockTask(id, { status: "succeeded", exitCode: 0, finishedAt: new Date().toISOString() });
    emitMock({ taskId: id, kind: "finished", timestamp: new Date().toISOString(), message: null, pid: 24108, exitCode: 0, cancelled: false });
  }, 500 + lines.length * 360);
  return task;
}

export async function listTasks(): Promise<TaskSnapshot[]> {
  return isDesktop ? invoke<TaskSnapshot[]>("list_tasks") : mockTasks;
}

export async function cancelTask(taskId: string): Promise<void> {
  if (isDesktop) {
    await invoke("cancel_task", { taskId });
    return;
  }
  updateMockTask(taskId, { status: "cancelled", exitCode: 130, finishedAt: new Date().toISOString() });
  emitMock({ taskId, kind: "finished", timestamp: new Date().toISOString(), message: null, pid: null, exitCode: 130, cancelled: true });
}

export async function previewCommand(request: CommandRequest): Promise<string[]> {
  if (isDesktop) return invoke<string[]>("preview_command", { request });
  const result = [mockRuntime.python.executable, "-m", "deepmd"];
  if (request.backend) result.push("--backend", request.backend);
  result.push(request.command, ...request.args);
  return result;
}

export async function subscribeToTaskEvents(
  callback: (event: ProcessEvent) => void,
): Promise<UnlistenFn> {
  if (isDesktop) {
    return listen<ProcessEvent>("studio://task-event", (event) => callback(event.payload));
  }
  mockListeners.add(callback);
  return () => mockListeners.delete(callback);
}

export async function chooseInputPath(directory = false): Promise<string | null> {
  if (!isDesktop) return window.prompt("Path", directory ? "C:\\Projects\\water" : "input.json");
  const selection = await open({ directory, multiple: false });
  return typeof selection === "string" ? selection : null;
}

export async function chooseTrainingInput(): Promise<string | null> {
  if (!isDesktop) return window.prompt("Training input", "C:\\Projects\\water-dpa4\\input.json");
  const selection = await open({
    directory: false,
    multiple: false,
    filters: [{ name: "DeePMD input", extensions: ["json", "yaml", "yml"] }],
  });
  return typeof selection === "string" ? selection : null;
}

export async function chooseSystemDirectories(): Promise<string[]> {
  if (!isDesktop) {
    const value = window.prompt("Dataset folders (one per line)", "C:\\Projects\\water-dpa4\\data");
    return value ? value.split(/\r?\n/).filter(Boolean) : [];
  }
  const selection = await open({ directory: true, multiple: true });
  if (typeof selection === "string") return [selection];
  return Array.isArray(selection) ? selection : [];
}

export async function chooseTrainingOutput(defaultPath: string): Promise<string | null> {
  if (!isDesktop) return window.prompt("Save generated input", defaultPath);
  return save({
    defaultPath,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
}

export async function chooseOutputPath(defaultPath?: string): Promise<string | null> {
  if (!isDesktop) return window.prompt("Output path", defaultPath ?? "model.pth");
  return save({ defaultPath });
}
