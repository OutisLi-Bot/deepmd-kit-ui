// SPDX-License-Identifier: LGPL-3.0-or-later

import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  FileCheck2,
  FileJson,
  FolderOpen,
  LoaderCircle,
  Play,
  RefreshCw,
  Save,
  Settings2,
  Sparkles,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { InputSchemaForm } from "../components/InputSchemaForm";
import { WorkflowIcon } from "../components/Icons";
import { ChoiceSelect } from "../components/ChoiceSelect";
import {
  collectMissing,
  compactInput,
  createTrainingDraft,
  displayName,
  isObject,
  type TrainingDraft,
} from "../lib/inputBuilder";
import {
  chooseInputPath,
  chooseTrainingInput,
  chooseTrainingOutput,
  getTrainingSchema,
  inspectTrainingInput,
  saveTrainingInput,
  validateTrainingInput,
} from "../lib/studio";
import type {
  BackendDefinition,
  CommandRequest,
  RuntimeReport,
  TrainingInputInspection,
  TrainingInputSchema,
  TrainingInputSummary,
  Workflow,
} from "../types";

interface TrainingWorkbenchProps {
  workflow: Workflow;
  backends: BackendDefinition[];
  runtime: RuntimeReport;
  backend: string;
  workingDirectory: string;
  onBackend: (backend: string) => void;
  onWorkingDirectory: (path: string) => void;
  onRun: (request: CommandRequest) => Promise<void>;
}

type Mode = "choose" | "existing" | "builder";
type StartMode = "fresh" | "restart" | "init" | "frozen";

const steps = [
  { id: "model", label: "Model", arguments: ["model"] },
  { id: "data", label: "Data & run", arguments: ["training"] },
  { id: "optimizer", label: "Optimizer", arguments: ["learning_rate", "optimizer"] },
  { id: "loss", label: "Loss & validation", arguments: ["loss", "validating"] },
  { id: "review", label: "Review", arguments: [] },
] as const;

function joinPath(directory: string, filename: string): string {
  const separator = directory.includes("\\") ? "\\" : "/";
  return `${directory.replace(/[\\/]$/, "")}${separator}${filename}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function formatSteps(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function InspectionSummary({ inspection }: { inspection: TrainingInputInspection }) {
  if (!inspection.valid || !inspection.summary) {
    return (
      <div className="training-input-error"><AlertCircle size={17} /><div><strong>Input needs attention</strong><span>{inspection.error ?? "Unknown validation error"}</span></div></div>
    );
  }
  const summary = inspection.summary;
  return (
    <div className="training-input-summary">
      <div><Sparkles size={17} /><span><small>Model</small><strong>{displayName(summary.model)}</strong></span></div>
      <div><Settings2 size={17} /><span><small>Optimizer</small><strong>{summary.optimizer}</strong></span></div>
      <div><CircleDot size={17} /><span><small>Steps</small><strong>{formatSteps(summary.steps)}</strong></span></div>
      <div><FolderOpen size={17} /><span><small>Systems</small><strong>{summary.system_count}</strong></span></div>
    </div>
  );
}

export function TrainingWorkbench({
  workflow,
  backends,
  runtime,
  backend,
  workingDirectory,
  onBackend,
  onWorkingDirectory,
  onRun,
}: TrainingWorkbenchProps) {
  const [mode, setMode] = useState<Mode>("choose");
  const [inputPath, setInputPath] = useState<string | null>(null);
  const [inspection, setInspection] = useState<TrainingInputInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [schema, setSchema] = useState<TrainingInputSchema | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [draft, setDraft] = useState<TrainingDraft>({});
  const [step, setStep] = useState(0);
  const [validation, setValidation] = useState<TrainingInputInspection | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [startMode, setStartMode] = useState<StartMode>("fresh");
  const [startSource, setStartSource] = useState<string | null>(null);
  const [skipNeighborStat, setSkipNeighborStat] = useState(true);
  const [showExecution, setShowExecution] = useState(false);

  const runtimeBackends = new Map(runtime.backends.map((item) => [item.id, item.available]));
  const schemaByName = useMemo(
    () => new Map(schema?.arguments.map((argument) => [argument.name, argument]) ?? []),
    [schema],
  );
  const compactDraft = useMemo(() => compactInput(draft), [draft]);
  const missing = useMemo(() => {
    if (!schema) return [];
    return schema.arguments.flatMap((argument) => {
      const value = compactDraft[argument.name];
      if (value === undefined && argument.optional) return [];
      return collectMissing(argument, value);
    });
  }, [compactDraft, schema]);
  const backendDefinition = backends.find((item) => item.id === backend);
  const preview = [
    "dp",
    backendDefinition?.flag ?? `--${backend}`,
    "train",
    inputPath ? basename(inputPath) : mode === "builder" ? "generated-input.json" : "<choose input>",
    ...(startMode === "restart" && startSource ? ["--restart", basename(startSource)] : []),
    ...(startMode === "init" && startSource ? ["--init-model", basename(startSource)] : []),
    ...(startMode === "frozen" && startSource ? ["--init-frz-model", basename(startSource)] : []),
    ...(skipNeighborStat ? ["--skip-neighbor-stat"] : []),
  ];

  async function loadSchema(): Promise<void> {
    setSchemaError(null);
    try {
      const loaded = await getTrainingSchema();
      setSchema(loaded);
      setDraft(createTrainingDraft(loaded));
    } catch (reason) {
      setSchemaError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function enterBuilder(): Promise<void> {
    setInputPath(null);
    setInspection(null);
    setValidation(null);
    setStep(0);
    setSubmitError(null);
    setMode("builder");
    if (!schema) await loadSchema();
  }

  async function enterExisting(): Promise<void> {
    setInputPath(null);
    setInspection(null);
    setValidation(null);
    setSubmitError(null);
    setMode("existing");
    await chooseExisting();
  }

  async function chooseExisting(): Promise<void> {
    const path = await chooseTrainingInput();
    if (!path) return;
    setInputPath(path);
    setInspection(null);
    setInspecting(true);
    setSubmitError(null);
    try {
      const result = await inspectTrainingInput(path);
      setInspection(result);
      if (result.working_directory) onWorkingDirectory(result.working_directory);
    } catch (reason) {
      setInspection({
        valid: false,
        error: reason instanceof Error ? reason.message : String(reason),
        input: null,
        summary: null,
        source_path: path,
        working_directory: null,
      });
    } finally {
      setInspecting(false);
    }
  }

  async function browseWorkingDirectory(): Promise<void> {
    const path = await chooseInputPath(true);
    if (path) onWorkingDirectory(path);
  }

  async function browseStartSource(): Promise<void> {
    const path = await chooseInputPath(startMode === "restart" || startMode === "init");
    if (path) setStartSource(path);
  }

  function buildArguments(path: string): string[] {
    const args = [path];
    if (startMode === "restart" && startSource) args.push("--restart", startSource);
    if (startMode === "init" && startSource) args.push("--init-model", startSource);
    if (startMode === "frozen" && startSource) args.push("--init-frz-model", startSource);
    if (skipNeighborStat) args.push("--skip-neighbor-stat");
    return args;
  }

  async function start(
    path: string,
    summary: TrainingInputSummary | null = mode === "existing" ? inspection?.summary ?? null : validation?.summary ?? null,
  ): Promise<void> {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onRun({
        backend,
        command: "train",
        args: buildArguments(path),
        workingDirectory,
        environment: {},
        label: `Train · ${basename(path)}`,
        training: {
          inputPath: path,
          totalSteps: summary?.steps ?? null,
          modelType: summary?.model ?? null,
          lossTypes: summary?.loss_types ?? [],
        },
      });
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  }

  async function validateDraft(): Promise<TrainingInputInspection> {
    setValidating(true);
    try {
      const result = await validateTrainingInput(compactDraft);
      setValidation(result);
      return result;
    } catch (reason) {
      const result: TrainingInputInspection = {
        valid: false,
        error: reason instanceof Error ? reason.message : String(reason),
        input: null,
        summary: null,
        source_path: null,
        working_directory: null,
      };
      setValidation(result);
      return result;
    } finally {
      setValidating(false);
    }
  }

  async function saveDraft(runAfterSave: boolean): Promise<void> {
    if (missing.length) return;
    setSaving(true);
    setSubmitError(null);
    try {
      const checked = await validateDraft();
      if (!checked.valid) return;
      const destination = await chooseTrainingOutput(inputPath ?? joinPath(workingDirectory, "input.json"));
      if (!destination) return;
      const saved = await saveTrainingInput(destination, compactDraft);
      setInputPath(saved);
      if (runAfterSave) await start(saved, checked.summary);
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    setValidation(null);
  }, [draft]);

  const executionPanel = (
    <aside className="training-run-card">
      <div className="run-card-heading">
        <p className="eyebrow">Execution</p>
        <h2>Train locally</h2>
        <span className="ready-label"><Check size={12} /> Isolated runtime ready</span>
      </div>
      <div className="run-control">
        <span>Backend</span>
        <ChoiceSelect
          ariaLabel="Training backend"
          value={backend}
          options={backends.map((item) => {
            const available = runtimeBackends.get(item.id) ?? false;
            return { value: item.id, label: item.id, description: available ? "Available" : "Not installed", disabled: !available };
          })}
          onChange={onBackend}
        />
      </div>
      <label className="run-control">
        <span>Project folder</span>
        <div className="path-compact">
          <input value={workingDirectory} readOnly title={workingDirectory} />
          <button className="icon-button" type="button" onClick={() => void browseWorkingDirectory()} title="Choose project folder"><FolderOpen size={16} /></button>
        </div>
      </label>

      <button className="execution-disclosure" type="button" onClick={() => setShowExecution((current) => !current)}>
        <span><Settings2 size={15} /> Training start & safety</span><ChevronDown className={showExecution ? "" : "collapsed"} size={15} />
      </button>
      {showExecution && (
        <div className="training-execution-options">
          <div className="run-control">
            <span>Start mode</span>
            <ChoiceSelect
              ariaLabel="Training start mode"
              value={startMode}
              options={[
                { value: "fresh", label: "Fresh training", description: "Start with newly initialized parameters" },
                { value: "restart", label: "Resume checkpoint", description: "Continue optimizer and step state" },
                { value: "init", label: "Initialize checkpoint", description: "Load model parameters only" },
                { value: "frozen", label: "Initialize frozen model", description: "Start from a portable model" },
              ]}
              onChange={(next) => { setStartMode(next as StartMode); setStartSource(null); }}
            />
          </div>
          {startMode !== "fresh" && (
            <button className="source-picker" type="button" onClick={() => void browseStartSource()}>
              <FolderOpen size={15} /><span>{startSource ? basename(startSource) : "Choose source"}<small>{startSource ?? "Checkpoint or model path"}</small></span>
            </button>
          )}
          <label className="compact-check"><input type="checkbox" checked={skipNeighborStat} onChange={(event) => setSkipNeighborStat(event.target.checked)} /><span><strong>Skip neighbor statistics</strong><small>Pass --skip-neighbor-stat</small></span></label>
        </div>
      )}

      <div className="command-preview training-preview">
        <div className="command-preview-heading"><span>Command</span><code>{preview.length} tokens</code></div>
        <pre><span>$</span> {preview.join(" ")}</pre>
      </div>
      {submitError && <div className="validation-message error"><AlertCircle size={15} /><span>{submitError}</span></div>}
      {mode === "existing" && (
        <button className="run-button" type="button" disabled={!inputPath || !inspection?.valid || submitting || (startMode !== "fresh" && !startSource)} onClick={() => inputPath && void start(inputPath)}>
          {submitting ? <LoaderCircle className="spin" size={16} /> : <Play size={16} fill="currentColor" />}
          {submitting ? "Starting…" : "Start training"}
        </button>
      )}
      {mode === "builder" && step === steps.length - 1 && (
        <button className="run-button" type="button" disabled={missing.length > 0 || saving || submitting || (startMode !== "fresh" && !startSource)} onClick={() => void saveDraft(true)}>
          {saving || submitting ? <LoaderCircle className="spin" size={16} /> : <Play size={16} fill="currentColor" />}
          {saving || submitting ? "Preparing…" : "Save & start training"}
        </button>
      )}
    </aside>
  );

  return (
    <div className="view workbench-view training-workbench">
      <header className="workflow-header training-header">
        <div className={`workflow-hero-icon accent-${workflow.accent}`}><WorkflowIcon name={workflow.icon} size={24} /></div>
        <div><p className="eyebrow">Training · guided workflow</p><h1>Train a model</h1><p>Start from a ready-made input, or create one step by step with guided controls.</p></div>
        {mode !== "choose" && <button className="secondary-button change-input-mode" type="button" onClick={() => setMode("choose")}><ArrowLeft size={14} /> Change input method</button>}
      </header>

      {mode === "choose" ? (
        <section className="training-mode-shell">
          <div className="training-mode-intro"><p className="eyebrow">Training input</p><h2>How would you like to begin?</h2><p>No command-line paths to type. Choose a file, or let Studio guide you through each training decision.</p></div>
          <div className="training-mode-grid">
            <button className="training-mode-card" type="button" onClick={() => void enterExisting()}>
              <span className="mode-card-icon existing"><Upload size={24} /></span>
              <span><small>Already configured</small><strong>Use existing JSON / YAML</strong><p>Pick an input, review the detected model and training settings, then start.</p></span>
              <ArrowRight size={18} />
            </button>
            <button className="training-mode-card featured" type="button" onClick={() => void enterBuilder()}>
              <span className="mode-card-icon builder"><Sparkles size={24} /></span>
              <span><small>Guided setup</small><strong>Generate input JSON</strong><p>Build model, data, optimizer, and loss settings through documented controls.</p></span>
              <ArrowRight size={18} />
            </button>
          </div>
          <div className="schema-source-note"><Braces size={16} /><span><strong>Always in sync</strong> Studio reads available fields, defaults, and descriptions directly from your DeePMD runtime.</span></div>
        </section>
      ) : mode === "existing" ? (
        <div className="training-layout">
          <main className="training-input-card">
            <div className="section-heading-row"><div><p className="eyebrow">Existing input</p><h2>Choose and verify</h2></div>{inputPath && <button className="text-button" type="button" onClick={() => void chooseExisting()}><RefreshCw size={14} /> Replace</button>}</div>
            <button className={inputPath ? "input-drop-card selected" : "input-drop-card"} type="button" onClick={() => void chooseExisting()}>
              <span className="input-file-icon">{inspecting ? <LoaderCircle className="spin" size={27} /> : inputPath ? <FileCheck2 size={27} /> : <FileJson size={27} />}</span>
              <span><strong>{inspecting ? "Checking input…" : inputPath ? basename(inputPath) : "Choose a DeePMD input"}</strong><small>{inputPath ?? "JSON, YAML, or YML"}</small></span>
              <span className="secondary-button"><FolderOpen size={14} /> Browse</span>
            </button>
            {inspection && <InspectionSummary inspection={inspection} />}
            {inspection?.valid && <div className="verified-strip"><CheckCircle2 size={16} /><span><strong>Ready to train</strong> The input is complete and compatible with the active runtime.</span></div>}
          </main>
          {executionPanel}
        </div>
      ) : (
        <div className="training-builder-shell">
          {!schema && !schemaError ? (
            <div className="schema-loading"><LoaderCircle className="spin" size={24} /><strong>Loading training options</strong><span>Studio is preparing the guided input builder.</span></div>
          ) : schemaError ? (
            <div className="schema-loading error"><AlertCircle size={24} /><strong>Could not load training options</strong><span>{schemaError}</span><button className="secondary-button" type="button" onClick={() => void loadSchema()}>Try again</button></div>
          ) : schema ? (
            <>
              <nav className="builder-stepper" aria-label="Input builder steps">
                {steps.map((item, index) => (
                  <button className={index === step ? "active" : index < step ? "complete" : ""} key={item.id} type="button" onClick={() => setStep(index)}>
                    <span>{index < step ? <Check size={13} /> : index + 1}</span><strong>{item.label}</strong>
                  </button>
                ))}
              </nav>
              <div className="training-layout builder-layout">
                <main className="training-builder-card">
                  {step < steps.length - 1 ? (
                    <>
                      <div className="builder-section-heading"><p className="eyebrow">Step {step + 1} of {steps.length}</p><h2>{steps[step].label}</h2><p>Required and common settings are shown first. Less frequently used controls remain available under Advanced.</p></div>
                      <div className="builder-argument-stack">
                        {steps[step].arguments.map((name) => {
                          const argument = schemaByName.get(name);
                          if (!argument) return null;
                          const raw = draft[name];
                          const value = isObject(raw) ? raw : {};
                          return (
                            <section className="builder-root-section" key={name}>
                              <header><span><strong>{displayName(name)}</strong><small>{argument.doc || `${displayName(name)} configuration`}</small></span></header>
                              <InputSchemaForm argument={argument} value={value} onChange={(next) => setDraft((current) => ({ ...current, [name]: next }))} />
                            </section>
                          );
                        })}
                      </div>
                      <div className="builder-navigation">
                        <button className="secondary-button" type="button" disabled={step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))}><ArrowLeft size={14} /> Back</button>
                        <button className="primary-button" type="button" onClick={() => setStep((current) => Math.min(steps.length - 1, current + 1))}>Continue <ArrowRight size={14} /></button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="builder-section-heading review-heading"><p className="eyebrow">Final review</p><h2>Your training input</h2><p>Studio keeps the JSON concise: untouched optional values remain DeePMD defaults.</p></div>
                      <div className="review-status-row">
                        <div className={missing.length ? "review-status warning" : "review-status ready"}>{missing.length ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}<span><strong>{missing.length ? `${missing.length} required fields remain` : "Required fields complete"}</strong><small>{missing.length ? missing.slice(0, 4).join(", ") : "Ready for a final compatibility check"}</small></span></div>
                        <button className="secondary-button" type="button" disabled={missing.length > 0 || validating} onClick={() => void validateDraft()}>{validating ? <LoaderCircle className="spin" size={14} /> : <FileCheck2 size={14} />} Validate</button>
                      </div>
                      {validation && <InspectionSummary inspection={validation} />}
                      <div className="json-review"><div><span><Braces size={15} /> input.json</span><code>{JSON.stringify(compactDraft).length} bytes</code></div><pre>{JSON.stringify(compactDraft, null, 2)}</pre></div>
                      <div className="builder-navigation">
                        <button className="secondary-button" type="button" onClick={() => setStep(step - 1)}><ArrowLeft size={14} /> Back</button>
                        <button className="secondary-button" type="button" disabled={missing.length > 0 || saving} onClick={() => void saveDraft(false)}>{saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />} Save JSON</button>
                      </div>
                    </>
                  )}
                </main>
                {executionPanel}
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
