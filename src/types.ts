// SPDX-License-Identifier: LGPL-3.0-or-later

export type JsonScalar = string | number | boolean | null;
export type FieldValue = string | boolean;
export type ViewId = "home" | "workbench" | "tasks" | "runtime";
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
    error?: string;
  };
  triton: {
    available: boolean;
    driver_ready: boolean;
    version?: string;
    distribution?: string;
    driver_error?: string;
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
