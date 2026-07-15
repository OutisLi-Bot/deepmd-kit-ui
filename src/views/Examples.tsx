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
  Play,
  Search,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { getExamples, prepareExample, readExampleFile } from "../lib/studio";
import type {
  BackendDefinition,
  CommandRequest,
  ExampleCatalog,
  ExampleEntry,
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
  expanded: Set<string>;
  selectedId: string | null;
  onToggle: (path: string) => void;
  onSelect: (entry: ExampleEntry) => void;
}) {
  return (
    <>
      {[...folder.folders.values()].map((child) => {
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
              <small>{child.entries.length + [...child.folders.values()].reduce((count, item) => count + item.entries.length, 0)}</small>
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
      {folder.entries.map((entry) => (
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
  const [preview, setPreview] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void getExamples()
      .then((result) => {
        if (disposed) return;
        setCatalog(result);
        const first = result.entries.at(0);
        setSelectedId(first?.id ?? null);
        setExpanded(new Set(result.entries.flatMap((entry) => {
          const parts = entry.path.split("/").slice(0, -1);
          return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
        })));
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
  const selected = catalog?.entries.find((entry) => entry.id === selectedId) ?? filtered.at(0) ?? null;
  const tree = useMemo(() => buildTree(filtered), [filtered]);
  const runtimeBackends = new Map(runtime.backends.map((item) => [item.id, item.available]));

  useEffect(() => {
    if (!selected) {
      setPreview("");
      return;
    }
    let disposed = false;
    setPreviewing(true);
    setRunError(null);
    void readExampleFile(selected.path)
      .then((content) => {
        if (disposed) return;
        try {
          setPreview(JSON.stringify(JSON.parse(content), null, 2));
        } catch {
          setPreview(content);
        }
      })
      .catch((reason: unknown) => {
        if (!disposed) setPreview(`Unable to preview this input.\n\n${reason instanceof Error ? reason.message : String(reason)}`);
      })
      .finally(() => { if (!disposed) setPreviewing(false); });
    return () => { disposed = true; };
  }, [selected]);

  function selectEntry(entry: ExampleEntry): void {
    setSelectedId(entry.id);
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

  async function runExample(): Promise<void> {
    if (!selected) return;
    setPreparing(true);
    setRunError(null);
    try {
      const prepared = await prepareExample(selected.id);
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
          totalSteps: selected.totalSteps,
          modelType: selected.modelType,
          lossTypes: selected.lossTypes,
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
          <p>Browse ready-to-run training inputs, inspect their settings, and launch a writable copy in one click.</p>
        </div>
        <div className="examples-count"><BookOpen size={17} /><strong>{catalog?.entries.length ?? 0}</strong><span>training inputs</span></div>
      </header>

      {loadError ? (
        <div className="empty-state large"><span><AlertCircle size={28} /></span><h2>Examples are unavailable</h2><p>{loadError}</p></div>
      ) : catalog?.entries.length ? (
        <div className="examples-layout">
          <aside className="example-browser-card">
            <div className="example-browser-heading"><span><Layers3 size={16} /><strong>Source tree</strong></span><small>{filtered.length} inputs</small></div>
            <label className="example-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find model, loss, or path" /></label>
            <div className="example-tree">
              <ExampleTree folder={tree} depth={0} expanded={expanded} selectedId={selected?.id ?? null} onToggle={toggleFolder} onSelect={selectEntry} />
              {!filtered.length && <div className="example-no-results">No training input matches “{query}”.</div>}
            </div>
          </aside>

          {selected && (
            <main className="example-detail-card">
              <div className="example-detail-hero">
                <span className="example-hero-icon"><Sparkles size={23} /></span>
                <div><p className="example-breadcrumb">{selected.path.split("/").slice(0, -1).join(" / ")}</p><h2>{selected.title}</h2><p>{selected.description ?? "A runnable training input maintained with DeePMD-kit."}</p></div>
              </div>

              <div className="example-facts">
                <div><Sparkles size={16} /><span><small>Model</small><strong>{selected.modelType}</strong></span></div>
                <div><Gauge size={16} /><span><small>Loss</small><strong>{selected.lossTypes.join(" · ")}</strong></span></div>
                <div><Clock3 size={16} /><span><small>Steps</small><strong>{formatSteps(selected.totalSteps)}</strong></span></div>
                <div><FolderOpen size={16} /><span><small>Systems</small><strong>{selected.systemCount || "Dynamic"}</strong></span></div>
              </div>

              <section className="example-preview-card">
                <header><span><FileJson size={16} /><strong>{selected.path.split("/").at(-1)}</strong></span><small>Read-only preview</small></header>
                <pre>{previewing ? "Loading input…" : preview}</pre>
              </section>

              <section className="example-launch-card">
                <div><p className="eyebrow">Ready to run</p><h3>Start this example</h3><p>Studio creates a private writable copy, preserves relative dataset paths, and opens the shared training monitor.</p></div>
                <label className="run-control">
                  <span>Backend</span>
                  <div className="select-wrap">
                    <select value={backend} onChange={(event) => onBackend(event.target.value)}>
                      {backends.map((item) => {
                        const available = runtimeBackends.get(item.id) ?? false;
                        return <option key={item.id} value={item.id} disabled={!available}>{item.id}{available ? "" : " · unavailable"}</option>;
                      })}
                    </select>
                    <ChevronDown size={15} />
                  </div>
                </label>
                {runError && <div className="validation-message error"><AlertCircle size={15} /><span>{runError}</span></div>}
                <button className="run-button example-run-button" type="button" disabled={preparing} onClick={() => void runExample()}>
                  {preparing ? <LoaderCircle className="spin" size={17} /> : <Play size={17} fill="currentColor" />}
                  {preparing ? "Preparing workspace…" : "Run example"}
                </button>
                <span className="example-safe-note"><CheckCircle2 size={14} /> The bundled source remains unchanged.</span>
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
