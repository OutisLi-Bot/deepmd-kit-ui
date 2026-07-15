// SPDX-License-Identifier: LGPL-3.0-or-later

import {
  AlertCircle,
  Check,
  ChevronDown,
  Code2,
  FolderOpen,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { CommandForm } from "../components/CommandForm";
import { ChoiceSelect } from "../components/ChoiceSelect";
import { WorkflowIcon } from "../components/Icons";
import { buildArguments, defaultFieldValues, quoteArgument } from "../lib/arguments";
import { chooseInputPath } from "../lib/studio";
import type {
  BackendDefinition,
  CatalogArgument,
  CommandRequest,
  FieldValue,
  RuntimeLocation,
  RuntimeReport,
  Workflow,
} from "../types";

interface WorkbenchProps {
  workflow: Workflow;
  backends: BackendDefinition[];
  runtime: RuntimeReport;
  runtimeLocation: RuntimeLocation;
  backend: string;
  workingDirectory: string;
  onBackend: (backend: string) => void;
  onWorkingDirectory: (path: string) => void;
  onRun: (request: CommandRequest) => Promise<void>;
}

interface EnvironmentRow {
  id: string;
  key: string;
  value: string;
}

function createEnvironmentRow(): EnvironmentRow {
  return { id: crypto.randomUUID(), key: "", value: "" };
}

export function Workbench({
  workflow,
  backends,
  runtime,
  runtimeLocation,
  backend,
  workingDirectory,
  onBackend,
  onWorkingDirectory,
  onRun,
}: WorkbenchProps) {
  const [values, setValues] = useState<Record<string, FieldValue>>(() => defaultFieldValues(workflow));
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [rawArguments, setRawArguments] = useState("");
  const [environment, setEnvironment] = useState<EnvironmentRow[]>([]);
  const [showExecution, setShowExecution] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    setValues(defaultFieldValues(workflow));
    setTouched(new Set());
    setRawArguments("");
    setSubmitError(null);
  }, [workflow]);

  const argumentBuild = useMemo(
    () => buildArguments(workflow, values, touched, rawArguments),
    [rawArguments, touched, values, workflow],
  );
  const runtimeBackends = new Map(runtime.backends.map((item) => [item.id, item.available]));
  const command = [
    runtimeLocation.executable,
    "-m",
    "deepmd",
    ...(backend ? ["--backend", backend] : []),
    workflow.name,
    ...argumentBuild.args,
  ];

  function changeField(argument: CatalogArgument, value: FieldValue): void {
    setValues((current) => {
      const next = { ...current, [argument.id]: value };
      if (argument.mutex_group) {
        for (const peer of workflow.arguments) {
          if (peer.id !== argument.id && peer.mutex_group === argument.mutex_group) {
            next[peer.id] = peer.kind === "boolean" ? Boolean(peer.default) : "";
          }
        }
      }
      return next;
    });
    setTouched((current) => {
      const next = new Set(current);
      next.add(argument.id);
      if (argument.mutex_group) {
        for (const peer of workflow.arguments) {
          if (peer.id !== argument.id && peer.mutex_group === argument.mutex_group) next.delete(peer.id);
        }
      }
      return next;
    });
  }

  function reset(): void {
    setValues(defaultFieldValues(workflow));
    setTouched(new Set());
    setRawArguments("");
    setEnvironment([]);
    setSubmitError(null);
  }

  async function browseWorkingDirectory(): Promise<void> {
    const path = await chooseInputPath(true);
    if (path) onWorkingDirectory(path);
  }

  async function run(): Promise<void> {
    if (argumentBuild.missing.length) return;
    const environmentVariables = Object.fromEntries(
      environment.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]),
    );
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onRun({
        backend: backend || null,
        command: workflow.name,
        args: argumentBuild.args,
        workingDirectory,
        environment: environmentVariables,
        label: workflow.title,
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  function patchEnvironment(id: string, patch: Partial<EnvironmentRow>): void {
    setEnvironment((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  return (
    <div className="view workbench-view">
      <header className="workflow-header">
        <div className={`workflow-hero-icon accent-${workflow.accent}`}>
          <WorkflowIcon name={workflow.icon} size={24} />
        </div>
        <div>
          <p className="eyebrow">{workflow.category} · dp {workflow.name}</p>
          <h1>{workflow.title}</h1>
          <p>{workflow.description}</p>
        </div>
      </header>

      <div className="workbench-grid">
        <main className="form-card">
          <CommandForm
            workflow={workflow}
            values={values}
            touched={touched}
            onChange={changeField}
            onReset={reset}
          />

          <div className="execution-options">
            <button
              className="advanced-toggle execution-toggle"
              type="button"
              onClick={() => setShowExecution((current) => !current)}
              aria-expanded={showExecution}
            >
              <span><Code2 size={16} /> Raw arguments & environment<small>Agent-friendly escape hatch</small></span>
              <ChevronDown className={showExecution ? "" : "collapsed"} size={17} />
            </button>
            {showExecution && (
              <div className="execution-body">
                <label className="form-field compact-field">
                  <span className="field-title-row"><strong>Additional arguments</strong></span>
                  <p className="field-help">Appended exactly after generated form arguments. Quotes are supported.</p>
                  <textarea
                    rows={3}
                    value={rawArguments}
                    onChange={(event) => setRawArguments(event.target.value)}
                    placeholder='--some-option "value with spaces"'
                  />
                </label>
                <div className="environment-editor">
                  <div className="environment-heading">
                    <span><strong>Environment variables</strong><small>Applied only to this process</small></span>
                    <button className="text-button" type="button" onClick={() => setEnvironment((rows) => [...rows, createEnvironmentRow()])}>
                      <Plus size={14} /> Add variable
                    </button>
                  </div>
                  {environment.map((row) => (
                    <div className="environment-row" key={row.id}>
                      <input aria-label="Environment variable name" value={row.key} onChange={(event) => patchEnvironment(row.id, { key: event.target.value })} placeholder="VARIABLE" />
                      <span>=</span>
                      <input aria-label="Environment variable value" value={row.value} onChange={(event) => patchEnvironment(row.id, { value: event.target.value })} placeholder="value" />
                      <button className="icon-button" type="button" onClick={() => setEnvironment((rows) => rows.filter((item) => item.id !== row.id))} title="Remove variable"><Trash2 size={15} /></button>
                    </div>
                  ))}
                  {!environment.length && <p className="empty-inline">No environment overrides.</p>}
                </div>
              </div>
            )}
          </div>
        </main>

        <aside className="run-card">
          <div className="run-card-heading">
            <p className="eyebrow">Execution</p>
            <h2>Run locally</h2>
            <span className="ready-label"><Check size={12} /> Runtime ready</span>
          </div>

          <div className="run-control">
            <span>Backend</span>
            <ChoiceSelect
              ariaLabel="Command backend"
              value={backend}
              options={backends.map((item) => {
                const available = runtimeBackends.get(item.id) ?? false;
                return { value: item.id, label: item.id, description: available ? "Available" : "Not installed", disabled: !available };
              })}
              onChange={onBackend}
            />
          </div>

          <label className="run-control">
            <span>Working directory</span>
            <div className="path-compact">
              <input value={workingDirectory} onChange={(event) => onWorkingDirectory(event.target.value)} />
              <button className="icon-button" type="button" onClick={browseWorkingDirectory} title="Choose folder"><FolderOpen size={16} /></button>
            </div>
          </label>

          <div className="command-preview">
            <div className="command-preview-heading"><span>Command preview</span><code>{command.length} tokens</code></div>
            <pre><span>$</span> {command.map(quoteArgument).join(" ")}</pre>
          </div>

          {argumentBuild.missing.length > 0 && (
            <div className="validation-message"><AlertCircle size={15} /><span>Complete: {argumentBuild.missing.join(", ")}</span></div>
          )}
          {submitError && <div className="validation-message error"><AlertCircle size={15} /><span>{submitError}</span></div>}

          <button
            className="run-button"
            type="button"
            disabled={argumentBuild.missing.length > 0 || submitting}
            onClick={run}
          >
            <Play size={16} fill="currentColor" />
            {submitting ? "Starting…" : `Run ${workflow.title}`}
          </button>
          <p className="run-note">The process runs without a shell and streams stdout and stderr into Tasks.</p>
        </aside>
      </div>
    </div>
  );
}
