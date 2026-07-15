// SPDX-License-Identifier: LGPL-3.0-or-later

import {
  Activity,
  Ban,
  ChevronDown,
  Clock3,
  Copy,
  Cpu,
  Eye,
  EyeOff,
  FolderOpen,
  Gauge,
  GripVertical,
  HardDrive,
  MemoryStick,
  Microchip,
  SlidersHorizontal,
  Sparkles,
  Thermometer,
  TrendingDown,
  Zap,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { openLocalPath } from "../lib/studio";
import { buildMetricSeries, groupMetricSeries, type TrainingMetricSeries } from "../lib/trainingMetrics";
import type { TaskSnapshot, TrainingResourceSample } from "../types";
import { StatusBadge } from "./TaskConsole";

interface TrainingMonitorProps {
  task: TaskSnapshot;
  onCancel?: () => void;
}

interface MonitorPreferences {
  resources: Record<"cpu" | "gpu" | "memory", boolean>;
  hiddenMetricGroups: string[];
  hiddenMetricSeries: string[];
  metricGroupOrder: string[];
}

const palette = ["#8b6cf6", "#20b8cd", "#f39a55", "#59b985", "#e56c8a", "#7f9cf5", "#c08cf4"];
const preferencesKey = "deepmd-studio-monitor-panels";
const defaultPreferences: MonitorPreferences = {
  resources: { cpu: true, gpu: true, memory: true },
  hiddenMetricGroups: [],
  hiddenMetricSeries: [],
  metricGroupOrder: [],
};

function loadPreferences(): MonitorPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(preferencesKey) ?? "null") as Partial<MonitorPreferences> | null;
    return {
      resources: { ...defaultPreferences.resources, ...(stored?.resources ?? {}) },
      hiddenMetricGroups: Array.isArray(stored?.hiddenMetricGroups) ? stored.hiddenMetricGroups : [],
      hiddenMetricSeries: Array.isArray(stored?.hiddenMetricSeries) ? stored.hiddenMetricSeries : [],
      metricGroupOrder: Array.isArray(stored?.metricGroupOrder) ? stored.metricGroupOrder : [],
    };
  } catch {
    return { ...defaultPreferences, resources: { ...defaultPreferences.resources } };
  }
}

function formatNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute === 0) return "0";
  if (absolute < 0.001 || absolute >= 1_000_000) return value.toExponential(2);
  return new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 }).format(value);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 GB";
  return `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 1 : 2)} GB`;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "Estimating…";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} sec`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours} hr ${minutes} min`;
  return `${minutes} min`;
}

function seriesColor(series: TrainingMetricSeries): string {
  if (series.phase === "train") return palette[0];
  if (series.phase === "validation") return palette[3];
  let hash = 0;
  for (const character of series.id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

function linePath(values: Array<{ x: number; y: number }>): string {
  return values.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
}

function LossChart({ series, unit }: { series: TrainingMetricSeries[]; unit: string | null }) {
  const width = 640;
  const height = 210;
  const left = 48;
  const right = 15;
  const top = 14;
  const bottom = 31;
  if (!series.length) return <div className="chart-awaiting"><EyeOff size={20} /><span>All curves are hidden</span></div>;
  const allPoints = series.flatMap((row) => row.points.filter((point) => Number.isFinite(point.value) && point.value > 0));
  if (!allPoints.length) return <div className="chart-awaiting"><TrendingDown size={20} /><span>Waiting for the first loss report</span></div>;

  const xMin = Math.min(...allPoints.map((point) => point.step));
  const xMax = Math.max(...allPoints.map((point) => point.step));
  const logs = allPoints.map((point) => Math.log10(point.value));
  const rawMin = Math.min(...logs);
  const rawMax = Math.max(...logs);
  const padding = Math.max(0.18, (rawMax - rawMin) * 0.12);
  const yMin = rawMin - padding;
  const yMax = rawMax + padding;
  const x = (value: number) => left + ((value - xMin) / Math.max(1, xMax - xMin)) * (width - left - right);
  const y = (value: number) => top + ((yMax - Math.log10(value)) / Math.max(0.1, yMax - yMin)) * (height - top - bottom);
  const grid = Array.from({ length: 4 }, (_, index) => yMin + ((yMax - yMin) * index) / 3);

  return (
    <svg className="loss-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Training metrics on a logarithmic scale">
      {grid.map((value) => {
        const yPosition = top + ((yMax - value) / Math.max(0.1, yMax - yMin)) * (height - top - bottom);
        return <g key={value}><line className="chart-grid-line" x1={left} x2={width - right} y1={yPosition} y2={yPosition} /><text className="chart-axis-label" x={left - 8} y={yPosition + 4} textAnchor="end">{`1e${Math.round(value)}`}</text></g>;
      })}
      <line className="chart-axis-line" x1={left} x2={width - right} y1={height - bottom} y2={height - bottom} />
      {unit && <text className="chart-unit-label" x={width - right} y={11} textAnchor="end">{unit}</text>}
      <text className="chart-axis-label" x={left} y={height - 9}>{new Intl.NumberFormat().format(xMin)}</text>
      <text className="chart-axis-label" x={width - right} y={height - 9} textAnchor="end">step {new Intl.NumberFormat().format(xMax)}</text>
      {series.map((row) => {
        const points = row.points.filter((point) => point.value > 0).map((point) => ({ x: x(point.step), y: y(point.value) }));
        const color = seriesColor(row);
        return (
          <g key={row.id} style={{ color }}>
            {points.length > 1 && <path className="chart-series-halo" d={linePath(points)} />}
            {points.length > 1 && <path className="chart-series-line" d={linePath(points)} />}
            {points.map((point, pointIndex) => pointIndex === points.length - 1 && <circle className="chart-series-dot" key={pointIndex} cx={point.x} cy={point.y} r="3.4" />)}
          </g>
        );
      })}
    </svg>
  );
}

function Sparkline({ values, color = "#8b6cf6" }: { values: number[]; color?: string }) {
  if (!values.length) return <svg className="resource-sparkline" viewBox="0 0 120 34" />;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const points = values.map((value, index) => ({
    x: (index / Math.max(1, values.length - 1)) * 120,
    y: 31 - ((value - minimum) / Math.max(1, maximum - minimum)) * 26,
  }));
  return <svg className="resource-sparkline" viewBox="0 0 120 34" style={{ color }}><path d={linePath(points)} /><path className="sparkline-fill" d={`${linePath(points)} L120,34 L0,34 Z`} /></svg>;
}

function GaugeRing({ value, color }: { value: number; color: string }) {
  const safe = Math.min(100, Math.max(0, value));
  const circumference = 2 * Math.PI * 26;
  return (
    <svg className="resource-ring" viewBox="0 0 64 64" style={{ color }}>
      <circle className="ring-track" cx="32" cy="32" r="26" />
      <circle className="ring-value" cx="32" cy="32" r="26" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - safe / 100)} />
      <text x="32" y="36" textAnchor="middle">{Math.round(safe)}%</text>
    </svg>
  );
}

function latestResource(task: TaskSnapshot): TrainingResourceSample | null {
  return task.training?.resources.at(-1) ?? null;
}

export function TrainingMonitor({ task, onCancel }: TrainingMonitorProps) {
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const [panelMenuOpen, setPanelMenuOpen] = useState(false);
  const [preferences, setPreferences] = useState<MonitorPreferences>(loadPreferences);
  const [draggedMetricGroup, setDraggedMetricGroup] = useState<string | null>(null);
  const [dropMetricGroup, setDropMetricGroup] = useState<string | null>(null);
  const panelMenuRef = useRef<HTMLDivElement>(null);
  const pointerDragGroupRef = useRef<string | null>(null);
  const training = task.training!;
  const metricSeries = useMemo(() => buildMetricSeries(training), [training]);
  const groups = useMemo(() => groupMetricSeries(metricSeries), [metricSeries]);
  const orderedGroups = useMemo(() => {
    const ranks = new Map(preferences.metricGroupOrder.map((group, index) => [group, index]));
    return [...groups.entries()].sort(([left], [right]) => {
      const leftRank = ranks.get(left);
      const rightRank = ranks.get(right);
      if (leftRank != null || rightRank != null) return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER);
      return left.localeCompare(right);
    });
  }, [groups, preferences.metricGroupOrder]);
  const visibleGroups = orderedGroups.filter(([group]) => !preferences.hiddenMetricGroups.includes(group));
  const resource = latestResource(task);
  const total = training.context.totalSteps;
  const progress = total ? Math.min(100, (training.currentStep / total) * 100) : null;
  const started = new Date(task.createdAt).getTime();
  const finished = task.finishedAt ? new Date(task.finishedAt).getTime() : now;
  const elapsed = Math.max(0, (finished - started) / 1000);
  const estimatedEta = training.etaSeconds ?? (total && training.stepTimeSeconds != null
    ? Math.max(0, total - training.currentStep) * training.stepTimeSeconds
    : null);
  const gpu = resource?.gpus.at(0) ?? null;
  const memoryPercent = resource?.systemMemoryTotalBytes
    ? resource.systemMemoryUsedBytes / resource.systemMemoryTotalBytes * 100
    : 0;
  const anyResourceVisible = Object.values(preferences.resources).some(Boolean);

  useEffect(() => {
    if (task.status !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [task.status]);

  useEffect(() => {
    localStorage.setItem(preferencesKey, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    if (!panelMenuOpen) return undefined;
    function closeOutside(event: PointerEvent): void {
      if (!panelMenuRef.current?.contains(event.target as Node)) setPanelMenuOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") setPanelMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [panelMenuOpen]);

  async function copyLog(): Promise<void> {
    await navigator.clipboard.writeText(task.log.join("\n"));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  }

  function setResourceVisible(name: keyof MonitorPreferences["resources"], visible: boolean): void {
    setPreferences((current) => ({ ...current, resources: { ...current.resources, [name]: visible } }));
  }

  function setMetricVisible(group: string, visible: boolean): void {
    setPreferences((current) => ({
      ...current,
      hiddenMetricGroups: visible
        ? current.hiddenMetricGroups.filter((item) => item !== group)
        : [...new Set([...current.hiddenMetricGroups, group])],
    }));
  }

  function setSeriesVisible(id: string, visible: boolean): void {
    setPreferences((current) => ({
      ...current,
      hiddenMetricSeries: visible
        ? current.hiddenMetricSeries.filter((item) => item !== id)
        : [...new Set([...current.hiddenMetricSeries, id])],
    }));
  }

  function reorderMetricGroup(source: string, target: string): void {
    if (source === target) return;
    const order = orderedGroups.map(([group]) => group);
    const sourceIndex = order.indexOf(source);
    const targetIndex = order.indexOf(target);
    if (sourceIndex < 0 || targetIndex < 0) return;
    order.splice(targetIndex, 0, ...order.splice(sourceIndex, 1));
    setPreferences((current) => ({ ...current, metricGroupOrder: order }));
  }

  function moveMetricGroup(group: string, offset: number): void {
    const order = visibleGroups.map(([name]) => name);
    const sourceIndex = order.indexOf(group);
    const target = order[sourceIndex + offset];
    if (sourceIndex >= 0 && target) reorderMetricGroup(group, target);
  }

  function metricGroupAtPoint(clientX: number, clientY: number): string | null {
    const card = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-metric-group]");
    return card?.dataset.metricGroup ?? null;
  }

  function startMetricPointerDrag(event: ReactPointerEvent<HTMLButtonElement>, group: string): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDragGroupRef.current = group;
    setDraggedMetricGroup(group);
  }

  function moveMetricPointerDrag(event: ReactPointerEvent<HTMLButtonElement>): void {
    const source = pointerDragGroupRef.current;
    if (!source) return;
    event.preventDefault();
    const target = metricGroupAtPoint(event.clientX, event.clientY);
    setDropMetricGroup(target && target !== source ? target : null);
  }

  function finishMetricPointerDrag(event: ReactPointerEvent<HTMLButtonElement>): void {
    const source = pointerDragGroupRef.current;
    const target = metricGroupAtPoint(event.clientX, event.clientY);
    if (source && target) reorderMetricGroup(source, target);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    pointerDragGroupRef.current = null;
    setDraggedMetricGroup(null);
    setDropMetricGroup(null);
  }

  function cancelMetricPointerDrag(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    pointerDragGroupRef.current = null;
    setDraggedMetricGroup(null);
    setDropMetricGroup(null);
  }

  function handleMetricHandleKey(event: ReactKeyboardEvent<HTMLButtonElement>, group: string): void {
    if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    moveMetricGroup(group, event.key === "ArrowLeft" ? -1 : 1);
  }

  return (
    <section className="training-monitor">
      <header className="monitor-header">
        <div className="monitor-title-block">
          <span className="monitor-live-icon"><Activity size={20} /></span>
          <span><small>Training monitor</small><strong>{task.request.label ?? "DeePMD training"}</strong></span>
        </div>
        <div className="monitor-actions">
          <div className="monitor-panel-control" ref={panelMenuRef}>
            <button className="console-button" type="button" aria-expanded={panelMenuOpen} onClick={() => setPanelMenuOpen((current) => !current)}><SlidersHorizontal size={13} /> Panels</button>
            {panelMenuOpen && (
              <div className="monitor-panel-menu">
                <header><div><small>Monitor layout</small><strong>Choose visible panels</strong></div><button type="button" onClick={() => setPreferences({ ...defaultPreferences, resources: { ...defaultPreferences.resources } })}>Reset</button></header>
                <section><p>System</p>
                  {(["cpu", "gpu", "memory"] as const).map((name) => (
                    <label key={name}><input type="checkbox" checked={preferences.resources[name]} onChange={(event) => setResourceVisible(name, event.target.checked)} /><span><strong>{name === "memory" ? "Memory" : name.toUpperCase()}</strong><small>{name === "cpu" ? "Process-tree utilization" : name === "gpu" ? "Utilization, VRAM, and temperature" : "Process and system RAM"}</small></span></label>
                  ))}
                </section>
                {groups.size > 0 && <section><p>Loss charts</p>
                  {orderedGroups.map(([group]) => (
                    <label key={group}><input type="checkbox" checked={!preferences.hiddenMetricGroups.includes(group)} onChange={(event) => setMetricVisible(group, event.target.checked)} /><span><strong>{group}</strong><small>{groups.get(group)?.map((row) => row.key).filter((value, index, values) => values.indexOf(value) === index).join(" · ")}</small></span></label>
                  ))}
                </section>}
              </div>
            )}
          </div>
          <StatusBadge status={task.status} />
          {task.status === "running" && onCancel && <button className="console-button danger" type="button" onClick={onCancel}><Ban size={13} /> Stop</button>}
        </div>
      </header>

      <div className="monitor-directory-bar">
        <FolderOpen size={15} />
        <span><small>Working directory</small><code title={task.request.workingDirectory}>{task.request.workingDirectory}</code></span>
        <button type="button" onClick={() => void openLocalPath(task.request.workingDirectory)}><FolderOpen size={13} /> Open folder</button>
      </div>

      <div className="monitor-progress-card">
        <div className="progress-copy">
          <p className="eyebrow">Training progress</p>
          <div className="progress-value"><strong>{progress == null ? "Running" : `${progress.toFixed(progress < 1 ? 2 : 1)}%`}</strong><span>{total ? `${new Intl.NumberFormat().format(training.currentStep)} / ${new Intl.NumberFormat().format(total)} steps` : `${new Intl.NumberFormat().format(training.currentStep)} steps completed`}</span></div>
          <div className="training-progress-track"><span style={{ width: `${progress ?? (task.status === "running" ? 8 : 100)}%` }} /></div>
        </div>
        <div className="progress-stats">
          <div><Clock3 size={15} /><span><small>Elapsed</small><strong>{formatDuration(elapsed)}</strong></span></div>
          <div><Gauge size={15} /><span><small>Remaining</small><strong>{task.status === "running" ? formatDuration(estimatedEta) : "—"}</strong></span></div>
          <div><Zap size={15} /><span><small>Step time</small><strong>{training.stepTimeSeconds != null ? `${training.stepTimeSeconds.toFixed(4)} s` : "Measuring…"}</strong></span></div>
        </div>
      </div>

      {anyResourceVisible && <div className="resource-monitor-grid">
        {preferences.resources.cpu && <article className="resource-card cpu-card">
          <header><span><Cpu size={16} /> CPU</span><span><small>Process tree</small><button type="button" onClick={() => setResourceVisible("cpu", false)} title="Hide CPU panel"><EyeOff size={13} /></button></span></header>
          <div className="resource-card-body"><GaugeRing value={resource?.cpuPercent ?? 0} color="#8b6cf6" /><div><strong>{resource ? `${resource.cpuPercent.toFixed(1)}%` : "Waiting"}</strong><span>of total compute</span></div></div>
          <Sparkline values={training.resources.map((sample) => sample.cpuPercent)} />
        </article>}
        {preferences.resources.gpu && <article className="resource-card gpu-card">
          <header><span><Microchip size={16} /> GPU</span><span><small>{gpu ? `GPU ${gpu.index}` : "Accelerator"}</small><button type="button" onClick={() => setResourceVisible("gpu", false)} title="Hide GPU panel"><EyeOff size={13} /></button></span></header>
          <div className="resource-card-body"><GaugeRing value={gpu?.utilizationPercent ?? 0} color="#20b8cd" /><div><strong>{gpu ? `${gpu.utilizationPercent.toFixed(0)}%` : "No telemetry"}</strong><span>{gpu ? gpu.name : "CPU / Metal is system managed"}</span></div></div>
          <div className="resource-card-footer"><span><MemoryStick size={13} /> {gpu ? `${formatBytes(gpu.memoryUsedBytes)} / ${formatBytes(gpu.memoryTotalBytes)}` : "—"}</span><span><Thermometer size={13} /> {gpu?.temperatureCelsius != null ? `${gpu.temperatureCelsius.toFixed(0)} °C` : "—"}</span></div>
        </article>}
        {preferences.resources.memory && <article className="resource-card memory-card">
          <header><span><MemoryStick size={16} /> Memory</span><span><small>System RAM</small><button type="button" onClick={() => setResourceVisible("memory", false)} title="Hide memory panel"><EyeOff size={13} /></button></span></header>
          <div className="resource-card-body"><GaugeRing value={memoryPercent} color="#f39a55" /><div><strong>{resource ? formatBytes(resource.processMemoryBytes) : "Waiting"}</strong><span>used by training</span></div></div>
          <div className="resource-card-footer"><span><HardDrive size={13} /> System {resource ? formatBytes(resource.systemMemoryUsedBytes) : "—"}</span><span>{resource ? `${memoryPercent.toFixed(0)}%` : "—"}</span></div>
        </article>}
      </div>}

      <div className="loss-monitor-heading"><div><p className="eyebrow">Live metrics</p><h3>Loss & validation</h3><p>Train and validation curves share one metric card. Toggle either curve or drag cards into the order you prefer.</p></div><span className="metric-count"><Sparkles size={14} /> {groups.size} {groups.size === 1 ? "metric" : "metrics"}</span></div>
      {groups.size ? (
        visibleGroups.length ? <div className="loss-card-grid">
          {visibleGroups.map(([group, series]) => {
            const keys = series.map((row) => row.key).filter((value, index, values) => values.indexOf(value) === index);
            const units = series.map((row) => row.unit).filter((unit): unit is string => unit != null).filter((value, index, values) => values.indexOf(value) === index);
            const unit = units.length === 1 ? units[0] : null;
            const displayedSeries = series.filter((row) => !preferences.hiddenMetricSeries.includes(row.id));
            const reports = Math.max(...series.map((row) => row.points.length), 0);
            const isDragging = draggedMetricGroup === group;
            const isDropTarget = dropMetricGroup === group && !isDragging;
            return <article
              className={`loss-chart-card${isDragging ? " is-dragging" : ""}${isDropTarget ? " is-drop-target" : ""}`}
              data-metric-group={group}
              key={group}
            >
              <header>
                <div className="metric-card-heading">
                  <button
                    className="metric-drag-handle"
                    type="button"
                    aria-label={`Reorder ${group} metric`}
                    title="Drag to reorder · Alt+Arrow keys"
                    onPointerDown={(event) => startMetricPointerDrag(event, group)}
                    onPointerMove={moveMetricPointerDrag}
                    onPointerUp={finishMetricPointerDrag}
                    onPointerCancel={cancelMetricPointerDrag}
                    onKeyDown={(event) => handleMetricHandleKey(event, group)}
                  ><GripVertical size={15} /></button>
                  <div><small>{keys.join(" · ")}{unit ? ` · ${unit}` : ""}</small><strong>{group}</strong></div>
                </div>
                <span><em>{reports} reports</em><button type="button" onClick={() => setMetricVisible(group, false)} title={`Hide ${group}`}><EyeOff size={13} /></button></span>
              </header>
              <LossChart series={displayedSeries} unit={unit} />
              <div className="loss-legend">
                {series.map((row) => {
                  const latest = row.points.at(-1);
                  const visible = !preferences.hiddenMetricSeries.includes(row.id);
                  const phaseLabel = row.phase === "validation" ? "Validation" : row.phase === "train" ? "Train" : row.phase;
                  return <button
                    className={`metric-series-toggle${visible ? "" : " is-hidden"}`}
                    key={row.id}
                    type="button"
                    aria-pressed={visible}
                    title={`${visible ? "Hide" : "Show"} ${phaseLabel} ${row.label}`}
                    onClick={() => setSeriesVisible(row.id, !visible)}
                  >
                    <i style={{ background: seriesColor(row) }} />
                    <span><strong>{row.label}</strong><small>{row.task ? `${row.task} · ` : ""}{phaseLabel}</small></span>
                    <code><span>{latest ? formatNumber(latest.value) : "—"}</span>{row.unit && <small>{row.unit}</small>}</code>
                    {visible ? <Eye size={14} /> : <EyeOff size={14} />}
                  </button>;
                })}
              </div>
            </article>;
          })}
        </div> : <div className="loss-empty-card compact"><SlidersHorizontal size={24} /><strong>All loss charts are hidden</strong><span>Use Panels to restore the metrics you want to follow.</span><button type="button" onClick={() => setPanelMenuOpen(true)}>Choose panels</button></div>
      ) : (
        <div className="loss-empty-card"><TrendingDown size={26} /><strong>Waiting for training metrics</strong><span>Initialization and dataset loading can take a moment. Charts will appear with the first reported step.</span></div>
      )}

      <details className="monitor-console">
        <summary><span><ChevronDown size={15} /> Process output</span><small>{task.log.length} lines</small></summary>
        <div className="monitor-console-actions"><button className="console-button" type="button" onClick={() => void copyLog()}><Copy size={13} /> {copied ? "Copied" : "Copy log"}</button></div>
        <pre>{task.log.length ? task.log.join("\n") : "Waiting for process output…"}</pre>
      </details>
    </section>
  );
}
