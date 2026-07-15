// SPDX-License-Identifier: LGPL-3.0-or-later

import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileJson,
  Folder,
  FolderOpen,
  Gauge,
  Layers3,
  LoaderCircle,
  PanelLeftClose,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useState } from "react";

import { ChoiceSelect } from "../components/ChoiceSelect";
import {
  getExampleDirectory,
  getExamples,
  openLocalPath,
  prepareExample,
  readExampleFile,
  saveTrainingInput,
  validateTrainingInput,
} from "../lib/studio";
import type {
  BackendDefinition,
  CommandRequest,
  ExampleCatalog,
  ExampleEntry,
  JsonValue,
  RuntimeReport,
} from "../types";

interface ExamplesProps {
  backends: BackendDefinition[];
  runtime: RuntimeReport;
  backend: string;
  onBackend: (backend: string) => void;
  onWorkingDirectory: (path: string) => void;
  onRun: (request: CommandRequest) => Promise<void>;
}

interface ExampleFolder {
  name: string;
  path: string;
  folders: Map<string, ExampleFolder>;
  entries: ExampleEntry[];
}

interface ParsedDraft {
  input: Record<string, JsonValue> | null;
  error: string | null;
}

function buildTree(entries: ExampleEntry[]): ExampleFolder {
  const root: ExampleFolder = { name: "Examples", path: "", folders: new Map(), entries: [] };
  for (const entry of entries) {
    const segments = entry.path.split("/");
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      const path = folder.path ? `${folder.path}/${segment}` : segment;
      if (!folder.folders.has(segment)) {
        folder.folders.set(segment, { name: segment, path, folders: new Map(), entries: [] });
      }
      folder = folder.folders.get(segment)!;
    }
    folder.entries.push(entry);
  }
  return root;
}

function folderEntryCount(folder: ExampleFolder): number {
  return folder.entries.length + [...folder.folders.values()]
    .reduce((count, child) => count + folderEntryCount(child), 0);
}

function parentPaths(entry: ExampleEntry): string[] {
  const parts = entry.path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function displayFolder(value: string): string {
  return value
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.length <= 4 || /\d/.test(part) ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatSteps(steps: number | null): string {
  return steps == null ? "Adaptive" : new Intl.NumberFormat().format(steps);
}

function parseDraft(source: string): ParsedDraft {
  try {
    const value = JSON.parse(source) as JsonValue;
    if (!value || Array.isArray(value) || typeof value !== "object") {
      return { input: null, error: "The training input must be a JSON object." };
    }
    return { input: value as Record<string, JsonValue>, error: null };
  } catch (reason) {
    return { input: null, error: reason instanceof Error ? reason.message : String(reason) };
  }
}

function draftFacts(input: Record<string, JsonValue> | null, fallback: ExampleEntry) {
  if (!input) {
    return {
      modelType: fallback.modelType,
      lossTypes: fallback.lossTypes,
      totalSteps: fallback.totalSteps,
      systemCount: fallback.systemCount,
    };
  }
  const model = typeof input.model === "object" && input.model && !Array.isArray(input.model)
    ? input.model as Record<string, JsonValue>
    : {};
  const descriptor = typeof model.descriptor === "object" && model.descriptor && !Array.isArray(model.descriptor)
    ? model.descriptor as Record<string, JsonValue>
    : {};
  const training = typeof input.training === "object" && input.training && !Array.isArray(input.training)
    ? input.training as Record<string, JsonValue>
    : {};
  const trainingData = typeof training.training_data === "object" && training.training_data && !Array.isArray(training.training_data)
    ? training.training_data as Record<string, JsonValue>
    : {};
  const systems = trainingData.systems;
  const lossTypes = new Set<string>();
  const loss = typeof input.loss === "object" && input.loss && !Array.isArray(input.loss)
    ? input.loss as Record<string, JsonValue>
    : null;
  if (typeof loss?.type === "string") lossTypes.add(loss.type);
  const lossDict = typeof input.loss_dict === "object" && input.loss_dict && !Array.isArray(input.loss_dict)
    ? input.loss_dict as Record<string, JsonValue>
    : null;
  for (const item of Object.values(lossDict ?? {})) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const lossType = (item as Record<string, JsonValue>).type;
      lossTypes.add(typeof lossType === "string" ? lossType : "ener");
    }
  }
  const stepKeys = ["numb_steps", "num_steps", "num_step", "numb_step", "stop_batch"];
  const totalSteps = stepKeys
    .map((key) => training[key])
    .find((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    modelType: model.model_dict ? "Multi-task" : typeof model.type === "string" && model.type !== "standard"
      ? model.type
      : typeof descriptor.type === "string" ? descriptor.type : fallback.modelType,
    lossTypes: lossTypes.size ? [...lossTypes] : fallback.lossTypes,
    totalSteps: totalSteps ?? fallback.totalSteps,
    systemCount: Array.isArray(systems) ? systems.length : typeof systems === "string" && systems ? 1 : fallback.systemCount,
  };
}

function ExampleTree({
  folder,
  depth,
  expanded,
  selectedId,
  onToggle,
  onSelect,
}: {
  folder: ExampleFolder;
  depth: number;
  expanded: ReadonlySet<string>;
  selectedId: string | null;
  onToggle: (path: string) => void;
  onSelect: (entry: ExampleEntry) => void;
}) {
  const folders = [...folder.folders.values()].sort((left, right) => left.name.localeCompare(right.name));
  const entries = [...folder.entries].sort((left, right) => left.path.localeCompare(right.path));
  return (
    <>
      {folders.map((child) => {
        const open = expanded.has(child.path);
        return (
          <div className="example-tree-branch" key={child.path}>
            <button
              className="example-folder-row"
              type="button"
              style={{ paddingLeft: 10 + depth * 15 }}
              onClick={() => onToggle(child.path)}
              aria-expanded={open}
            >
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {open ? <FolderOpen size={16} /> : <Folder size={16} />}
              <span>{displayFolder(child.name)}</span>
              <small>{folderEntryCount(child)}</small>
            </button>
            {open && (
              <ExampleTree
                folder={child}
                depth={depth + 1}
                expanded={expanded}
                selectedId={selectedId}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </div>
        );
      })}
      {entries.map((entry) => (
        <button
          className={selectedId === entry.id ? "example-file-row active" : "example-file-row"}
          key={entry.id}
          type="button"
          style={{ paddingLeft: 31 + depth * 15 }}
          onClick={() => onSelect(entry)}
        >
          <FileJson size={15} />
          <span>{entry.path.split("/").at(-1)}</span>
          {entry.suggestedBackend && <small>{entry.suggestedBackend === "pytorch" ? "PT" : entry.suggestedBackend}</small>}
        </button>
      ))}
    </>
  );
}

export function Examples({
  backends,
  runtime,
  backend,
  onBackend,
  onWorkingDirectory,
  onRun,
}: ExamplesProps) {
  const [catalog, setCatalog] = useState<ExampleCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sourceText, setSourceText] = useState("");
  const [draft, setDraft] = useState("");
  const [sourceDirectory, setSourceDirectory] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void getExamples()
      .then((result) => {
        if (disposed) return;
        setCatalog(result);
        setSelectedId(result.entries.at(0)?.id ?? null);
        setExpanded(new Set());
      })
      .catch((reason: unknown) => {
        if (!disposed) setLoadError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { disposed = true; };
  }, []);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (catalog?.entries ?? []).filter((entry) =>
      !normalized || [entry.path, entry.title, entry.modelType, ...entry.lossTypes]
        .some((value) => value.toLowerCase().includes(normalized)),
    );
  }, [catalog, query]);
  const selected = filtered.find((entry) => entry.id === selectedId) ?? filtered.at(0) ?? null;
  const tree = useMemo(() => buildTree(filtered), [filtered]);
  const visibleExpanded = useMemo(() => {
    if (!query.trim()) return expanded;
    return new Set(filtered.flatMap(parentPaths));
  }, [expanded, filtered, query]);
  const runtimeBackends = new Map(runtime.backends.map((item) => [item.id, item.available]));
  const parsed = useMemo(() => parseDraft(draft), [draft]);
  const facts = selected ? draftFacts(parsed.input, selected) : null;
  const modified = draft !== sourceText;

  useEffect(() => {
    if (!selected) {
      setSourceText("");
      setDraft("");
      setSourceDirectory("");
      return;
    }
    let disposed = false;
    setPreviewing(true);
    setRunError(null);
    void Promise.all([readExampleFile(selected.path), getExampleDirectory(selected.path)])
      .then(([content, directory]) => {
        if (disposed) return;
        let formatted = content;
        try {
          formatted = `${JSON.stringify(JSON.parse(content), null, 2)}\n`;
        } catch {
          // The editor exposes the original text when formatting is unavailable.
        }
        setSourceText(formatted);
        setDraft(formatted);
        setSourceDirectory(directory);
      })
      .catch((reason: unknown) => {
        if (!disposed) setRunError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (!disposed) setPreviewing(false); });
    return () => { disposed = true; };
  }, [selected]);

  function selectEntry(entry: ExampleEntry): void {
    setSelectedId(entry.id);
    setExpanded((current) => new Set([...current, ...parentPaths(entry)]));
    if (entry.suggestedBackend && runtimeBackends.get(entry.suggestedBackend)) {
      onBackend(entry.suggestedBackend);
    }
  }

  function toggleFolder(path: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function formatDraft(): void {
    if (!parsed.input) return;
    setDraft(`${JSON.stringify(parsed.input, null, 2)}\n`);
  }

  function handleEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const target = event.currentTarget;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    setDraft(`${draft.slice(0, start)}  ${draft.slice(end)}`);
    window.requestAnimationFrame(() => {
      target.selectionStart = start + 2;
      target.selectionEnd = start + 2;
    });
  }

  async function runExample(): Promise<void> {
    if (!selected || !parsed.input) {
      setRunError(parsed.error ?? "The edited input is not valid JSON.");
      return;
    }
    setPreparing(true);
    setRunError(null);
    try {
      const validation = await validateTrainingInput(parsed.input);
      if (!validation.valid) throw new Error(validation.error ?? "The edited training input is invalid.");
      const prepared = await prepareExample(selected.id);
      await saveTrainingInput(prepared.inputPath, parsed.input);
      onWorkingDirectory(prepared.workingDirectory);
      await onRun({
        backend,
        command: "train",
        args: [prepared.inputPath, "--skip-neighbor-stat"],
        workingDirectory: prepared.workingDirectory,
        environment: {},
        label: `Example · ${selected.title}`,
        training: {
          inputPath: prepared.inputPath,
          totalSteps: validation.summary?.steps ?? facts?.totalSteps ?? null,
          modelType: validation.summary?.model ?? facts?.modelType ?? null,
          lossTypes: validation.summary?.loss_types ?? facts?.lossTypes ?? [],
        },
      });
    } catch (reason) {
      setRunError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPreparing(false);
    }
  }

  if (!catalog && !loadError) {
    return <div className="view examples-view"><div className="examples-loading"><LoaderCircle className="spin" size={24} /><strong>Opening examples</strong><span>Reading the examples included with your DeePMD runtime.</span></div></div>;
  }

  return (
    <div className="view examples-view">
      <header className="page-header examples-header">
        <div>
          <p className="eyebrow">Learn by running</p>
          <h1>Examples</h1>
          <p>Browse a ready-made input, adapt it in place, and run a private copy without touching the original.</p>
        </div>
        <div className="examples-count"><BookOpen size={17} /><strong>{catalog?.entries.length ?? 0}</strong><span>training inputs</span></div>
      </header>

      {loadError ? (
        <div className="empty-state large"><span><AlertCircle size={28} /></span><h2>Examples are unavailable</h2><p>{loadError}</p></div>
      ) : catalog?.entries.length ? (
        <div className="examples-layout">
          <aside className="example-browser-card">
            <div className="example-browser-heading">
              <span><Layers3 size={16} /><strong>Source tree</strong></span>
              <span className="example-tree-actions"><small>{filtered.length} inputs</small><button type="button" onClick={() => setExpanded(new Set())} title="Collapse all folders"><PanelLeftClose size={14} /></button></span>
            </div>
            <label className="example-search">
              <Search size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find model, loss, or path" />
              {query && <button type="button" onClick={() => setQuery("")} title="Clear search"><X size={13} /></button>}
            </label>
            <div className="example-tree">
              <ExampleTree folder={tree} depth={0} expanded={visibleExpanded} selectedId={selected?.id ?? null} onToggle={toggleFolder} onSelect={selectEntry} />
              {!filtered.length && <div className="example-no-results">No training input matches “{query}”.</div>}
            </div>
          </aside>

          {selected && facts && (
            <main className="example-detail-card">
              <div className="example-detail-hero">
                <span className="example-hero-icon"><Sparkles size={23} /></span>
                <div><p className="example-breadcrumb">{selected.path.split("/").slice(0, -1).join(" / ")}</p><h2>{selected.title}</h2><p>{selected.description ?? "A runnable training input maintained with DeePMD-kit."}</p></div>
              </div>

              <div className="example-facts">
                <div><Sparkles size={16} /><span><small>Model</small><strong>{facts.modelType}</strong></span></div>
                <div><Gauge size={16} /><span><small>Loss</small><strong>{facts.lossTypes.join(" · ")}</strong></span></div>
                <div><Clock3 size={16} /><span><small>Steps</small><strong>{formatSteps(facts.totalSteps)}</strong></span></div>
                <div><FolderOpen size={16} /><span><small>Systems</small><strong>{facts.systemCount || "Dynamic"}</strong></span></div>
              </div>

              <section className="example-editor-card">
                <header>
                  <span><FileJson size={16} /><strong>{selected.path.split("/").at(-1)}</strong><i>{modified ? "Edited" : "Original"}</i></span>
                  <div>
                    <button type="button" disabled={!modified} onClick={() => setDraft(sourceText)}><RotateCcw size={13} /> Revert</button>
                    <button type="button" disabled={!parsed.input} onClick={formatDraft}><WandSparkles size={13} /> Format</button>
                  </div>
                </header>
                <textarea
                  aria-label="Editable example training input"
                  value={previewing ? "Loading input…" : draft}
                  disabled={previewing}
                  spellCheck={false}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleEditorKeyDown}
                />
                <footer className={parsed.error ? "invalid" : "valid"}>
                  {parsed.error ? <><AlertCircle size={13} /><span>{parsed.error}</span></> : <><CheckCircle2 size={13} /><span>Valid JSON · edits are written to the private run copy</span></>}
                </footer>
              </section>

              <section className="example-launch-card">
                <div className="example-launch-copy"><p className="eyebrow">Ready to run</p><h3>Start this example</h3><p>Studio validates your edited input, copies its data, and opens the shared training monitor.</p></div>
                <div className="run-control">
                  <span>Backend</span>
                  <ChoiceSelect
                    ariaLabel="Example backend"
                    value={backend}
                    options={backends.map((item) => {
                      const available = runtimeBackends.get(item.id) ?? false;
                      return { value: item.id, label: item.id, description: available ? "Available" : "Not installed", disabled: !available };
                    })}
                    onChange={onBackend}
                  />
                </div>
                <button className="run-button example-run-button" type="button" disabled={preparing || !parsed.input} onClick={() => void runExample()}>
                  {preparing ? <LoaderCircle className="spin" size={17} /> : <Play size={17} fill="currentColor" />}
                  {preparing ? "Preparing workspace…" : "Run example"}
                </button>
                <div className="example-directory-row">
                  <FolderOpen size={15} />
                  <span><small>Source folder</small><code title={sourceDirectory}>{sourceDirectory || "Resolving…"}</code></span>
                  <button type="button" disabled={!sourceDirectory} onClick={() => void openLocalPath(sourceDirectory)}><FolderOpen size={13} /> Open</button>
                </div>
                {runError && <div className="validation-message error"><AlertCircle size={15} /><span>{runError}</span></div>}
                <span className="example-safe-note"><CheckCircle2 size={14} /> The bundled source remains unchanged; each run gets its own working directory.</span>
              </section>
            </main>
          )}
        </div>
      ) : (
        <div className="empty-state large"><span><BookOpen size={28} /></span><h2>No examples were bundled</h2><p>Install or update the application runtime to add version-matched training examples.</p></div>
      )}
    </div>
  );
}
