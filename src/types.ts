// SPDX-License-Identifier: LGPL-3.0-or-later

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type FieldValue = string | boolean;
export type ViewId = "home" | "workbench" | "tasks" | "runtime" | "examples";
export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface CatalogArgument {
  id: string;
  flags: string[];
  positional: boolean;
  required: boolean;
  kind: "boolean" | "select" | "integer" | "number" | "path" | "text";
  nargs: string | number | null;
  default: JsonScalar | JsonScalar[];
  choices: JsonScalar[];
  help: string;
  metavar: JsonScalar | JsonScalar[];
  mutex_group: string | null;
  condition?: {
    field: string;
    equals: string;
  } | null;
}

export interface Workflow {
  name: string;
  usage: string;
  arguments: CatalogArgument[];
  category: string;
  title: string;
  description: string;
  icon: string;
  accent: string;
  featured?: boolean;
  legacy?: boolean;
}

export interface BackendDefinition {
  id: string;
  aliases: string[];
  flag: string;
  available: boolean;
}

export interface CommandCatalog {
  schema_version: number;
  deepmd_version: string;
  categories: string[];
  backends: BackendDefinition[];
  commands: Workflow[];
}

export interface InputVariant {
  object: "Variant";
  flag_name: string;
  optional: boolean;
  default_tag: string;
  choice_dict: Record<string, InputArgument>;
}

export interface InputArgument {
  object: "Argument";
  name: string;
  type: string[];
  optional: boolean;
  alias: string[];
  doc: string;
  repeat: boolean;
  sub_fields: Record<string, InputArgument>;
  sub_variants: Record<string, InputVariant>;
  choices?: JsonScalar[];
  default?: JsonValue;
}

export interface TrainingInputSchema {
  schema_version: number;
  deepmd_version: string;
  arguments: InputArgument[];
}

export interface TrainingInputSummary {
  model: string;
  model_type: string;
  optimizer: string;
  steps: number;
  systems: string | string[];
  system_count: number;
  loss_types: string[];
}

export interface TrainingInputInspection {
  valid: boolean;
  error: string | null;
  input: Record<string, JsonValue> | null;
  summary: TrainingInputSummary | null;
  source_path: string | null;
  working_directory: string | null;
}

export interface BackendReport {
  id: string;
  package: string | null;
  available: boolean;
}

export interface RuntimeReport {
  schema_version: number;
  deepmd_version: string;
  python: {
    version: string;
    executable: string;
    prefix: string;
    bundled: boolean;
  };
  platform: {
    system: string;
    release: string;
    machine: string;
    node: string;
  };
  package_root: string;
  backends: BackendReport[];
  accelerator: {
    kind: string;
    available: boolean;
    devices: Array<{
      index: number;
      name: string;
      memory_bytes: number;
    }>;
    torch_version?: string;
    cuda_version?: string | null;
    probing?: boolean;
    error?: string;
  };
  triton: {
    available: boolean;
    driver_ready: boolean;
    version?: string;
    distribution?: string;
    driver_error?: string;
    probing?: boolean;
    error?: string;
  };
  runtime_manifest?: {
    schema_version: number;
    profile: string;
    accelerator: string;
    source_wheel: string;
    runtime_channel?: RuntimeChannel;
    update_mode?: string;
    deepmd_source?: {
      repository: string;
      ref: string;
      commit: string;
    };
  } | null;
}

export interface RuntimeLocation {
  executable: string;
  source: "bundled" | "managed";
}

export interface SystemReport {
  operatingSystem: {
    name: string;
    version: string;
    kernel: string;
    hostname: string;
    architecture: string;
  };
  cpu: {
    brand: string;
    vendor: string;
    physicalCores: number;
    logicalCores: number;
    frequencyMhz: number;
  };
  memory: {
    totalBytes: number;
    availableBytes: number;
  };
  disks: Array<{
    name: string;
    mountPoint: string;
    fileSystem: string;
    kind: string;
    totalBytes: number;
    availableBytes: number;
    removable: boolean;
  }>;
}

export type RuntimeChannel = "stable" | "beta" | "custom";

export interface RuntimeSettings {
  channel: RuntimeChannel;
  repository: string;
  git_ref: string;
  github_proxy: string;
}

export interface RuntimePlan {
  schema_version: number;
  channel: RuntimeChannel;
  repository: string;
  repository_slug: string;
  requested_ref: string;
  resolved_ref: string;
  commit: string;
  short_commit: string;
  display_version: string;
  archive_url: string;
  github_proxy: string;
  update_mode: string;
}

export interface RuntimeInstallResult {
  schema_version: number;
  runtime: string;
  plan: RuntimePlan;
  doctor: RuntimeReport;
  restart_required: boolean;
}

export interface ApplicationUpdatePlan {
  schema_version: number;
  repository_slug: string;
  current_version: string;
  latest_version: string;
  tag: string;
  update_available: boolean;
  platform_key: string;
  asset_name: string;
  asset_url: string;
  sha256: string;
  bytes: number;
  github_proxy: string;
}

export interface ApplicationDownloadResult {
  schema_version: number;
  path: string;
  sha256: string;
  bytes: number;
  plan: ApplicationUpdatePlan;
}

export interface CommandRequest {
  backend: string | null;
  command: string;
  args: string[];
  workingDirectory: string;
  environment: Record<string, string>;
  label: string | null;
  training?: TrainingContext | null;
}

export interface TrainingContext {
  inputPath: string | null;
  totalSteps: number | null;
  modelType: string | null;
  lossTypes: string[];
}

export interface TrainingMetricSample {
  step: number;
  phase: string;
  task: string | null;
  values: Record<string, number>;
  learningRate: number | null;
  timestamp: string;
}

export interface GpuResourceSample {
  index: number;
  name: string;
  utilizationPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  temperatureCelsius: number | null;
}

export interface TrainingResourceSample {
  timestamp: string;
  cpuPercent: number;
  processMemoryBytes: number;
  systemMemoryUsedBytes: number;
  systemMemoryTotalBytes: number;
  gpus: GpuResourceSample[];
}

export interface TrainingSnapshot {
  context: TrainingContext;
  currentStep: number;
  etaSeconds: number | null;
  stepTimeSeconds: number | null;
  metrics: TrainingMetricSample[];
  resources: TrainingResourceSample[];
}

export interface TrainingUpdate {
  taskId: string;
  training: TrainingSnapshot;
}

export interface TaskSnapshot {
  id: string;
  request: CommandRequest;
  status: TaskStatus;
  pid: number | null;
  exitCode: number | null;
  createdAt: string;
  finishedAt: string | null;
  log: string[];
  training: TrainingSnapshot | null;
}

export interface ExampleEntry {
  id: string;
  path: string;
  title: string;
  category: string;
  modelType: string;
  lossTypes: string[];
  totalSteps: number | null;
  systemCount: number;
  suggestedBackend: string | null;
  description: string | null;
}

export interface ExampleCatalog {
  entries: ExampleEntry[];
}

export interface PreparedExample {
  inputPath: string;
  workingDirectory: string;
  workspaceRoot: string;
}

export type ProcessEventKind = "started" | "stdout" | "stderr" | "finished" | "error";

export interface ProcessEvent {
  taskId: string;
  kind: ProcessEventKind;
  timestamp: string;
  message: string | null;
  pid: number | null;
  exitCode: number | null;
  cancelled: boolean;
}
