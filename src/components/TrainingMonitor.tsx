// SPDX-License-Identifier: LGPL-3.0-or-later

import {
  Activity,
  Ban,
  ChevronDown,
  Clock3,
  Copy,
  Cpu,
  Gauge,
  HardDrive,
  MemoryStick,
  Microchip,
  Sparkles,
  Thermometer,
  TrendingDown,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { buildMetricSeries, groupMetricSeries, type TrainingMetricSeries } from "../lib/trainingMetrics";
import type { TaskSnapshot, TrainingResourceSample } from "../types";
import { StatusBadge } from "./TaskConsole";

interface TrainingMonitorProps {
  task: TaskSnapshot;
  onCancel?: () => void;
}

const palette = ["#8b6cf6", "#20b8cd", "#f39a55", "#59b985", "#e56c8a", "#7f9cf5", "#c08cf4"];

function formatNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute === 0) return "0";
  if (absolute < 0.001 || absolute >= 1_000) return value.toExponential(2);
  return value.toPrecision(3);
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

function seriesColor(series: TrainingMetricSeries, index: number): string {
  if (series.phase === "validation") return palette[(index * 2 + 1) % palette.length];
  return palette[(index * 2) % palette.length];
}

function linePath(values: Array<{ x: number; y: number }>): string {
  return values.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
}

function LossChart({ series }: { series: TrainingMetricSeries[] }) {
  const width = 640;
  const height = 210;
  const left = 48;
  const right = 15;
  const top = 14;
  const bottom = 31;
  const allPoints = series.flatMap((row) => row.points.filter((point) => Number.isFinite(point.value) && point.value > 0));
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

  if (!allPoints.length) return <div className="chart-awaiting"><TrendingDown size={20} /><span>Waiting for the first loss report</span></div>;

  return (
    <svg className="loss-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Training metrics on a logarithmic scale">
      <defs>
        <linearGradient id="chartFade" x1="0" x2="1"><stop offset="0" stopColor="currentColor" stopOpacity="0.28" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient>
      </defs>
      {grid.map((value) => {
        const yPosition = top + ((yMax - value) / Math.max(0.1, yMax - yMin)) * (height - top - bottom);
        return <g key={value}><line className="chart-grid-line" x1={left} x2={width - right} y1={yPosition} y2={yPosition} /><text className="chart-axis-label" x={left - 8} y={yPosition + 4} textAnchor="end">{`1e${Math.round(value)}`}</text></g>;
      })}
      <line className="chart-axis-line" x1={left} x2={width - right} y1={height - bottom} y2={height - bottom} />
      <text className="chart-axis-label" x={left} y={height - 9}>{new Intl.NumberFormat().format(xMin)}</text>
      <text className="chart-axis-label" x={width - right} y={height - 9} textAnchor="end">step {new Intl.NumberFormat().format(xMax)}</text>
      {series.map((row, index) => {
        const points = row.points.filter((point) => point.value > 0).map((point) => ({ x: x(point.step), y: y(point.value) }));
        const color = seriesColor(row, index);
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
  const training = task.training!;
  const metricSeries = useMemo(() => buildMetricSeries(training), [training]);
  const groups = useMemo(() => groupMetricSeries(metricSeries), [metricSeries]);
  const resource = latestResource(task);
  const total = training.context.totalSteps;
  const progress = total ? Math.min(100, (training.currentStep / total) * 100) : null;
  const started = new Date(task.createdAt).getTime();
  const finished = task.finishedAt ? new Date(task.finishedAt).getTime() : now;
  const elapsed = Math.max(0, (finished - started) / 1000);
  const estimatedEta = training.etaSeconds ?? (total && training.stepTimeSeconds
    ? Math.max(0, total - training.currentStep) * training.stepTimeSeconds
    : null);
  const gpu = resource?.gpus.at(0) ?? null;
  const memoryPercent = resource?.systemMemoryTotalBytes
    ? resource.systemMemoryUsedBytes / resource.systemMemoryTotalBytes * 100
    : 0;

  useEffect(() => {
    if (task.status !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [task.status]);

  async function copyLog(): Promise<void> {
    await navigator.clipboard.writeText(task.log.join("\n"));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  }

  return (
    <section className="training-monitor">
      <header className="monitor-header">
        <div className="monitor-title-block">
          <span className="monitor-live-icon"><Activity size={20} /></span>
          <span><small>Training monitor</small><strong>{task.request.label ?? "DeePMD training"}</strong></span>
        </div>
        <div className="monitor-actions">
          <StatusBadge status={task.status} />
          {task.status === "running" && onCancel && <button className="console-button danger" type="button" onClick={onCancel}><Ban size={13} /> Stop</button>}
        </div>
      </header>

      <div className="monitor-progress-card">
        <div className="progress-copy">
          <p className="eyebrow">Optimization progress</p>
          <div className="progress-value"><strong>{progress == null ? "Running" : `${progress.toFixed(progress < 1 ? 2 : 1)}%`}</strong><span>{total ? `${new Intl.NumberFormat().format(training.currentStep)} / ${new Intl.NumberFormat().format(total)} steps` : `${new Intl.NumberFormat().format(training.currentStep)} steps completed`}</span></div>
          <div className="training-progress-track"><span style={{ width: `${progress ?? (task.status === "running" ? 8 : 100)}%` }} /></div>
        </div>
        <div className="progress-stats">
          <div><Clock3 size={15} /><span><small>Elapsed</small><strong>{formatDuration(elapsed)}</strong></span></div>
          <div><Gauge size={15} /><span><small>Remaining</small><strong>{task.status === "running" ? formatDuration(estimatedEta) : "—"}</strong></span></div>
          <div><Zap size={15} /><span><small>Step time</small><strong>{training.stepTimeSeconds ? `${training.stepTimeSeconds.toFixed(4)} s` : "Measuring…"}</strong></span></div>
        </div>
      </div>

      <div className="resource-monitor-grid">
        <article className="resource-card cpu-card">
          <header><span><Cpu size={16} /> CPU</span><small>Process tree</small></header>
          <div className="resource-card-body"><GaugeRing value={resource?.cpuPercent ?? 0} color="#8b6cf6" /><div><strong>{resource ? `${resource.cpuPercent.toFixed(1)}%` : "Waiting"}</strong><span>of total compute</span></div></div>
          <Sparkline values={training.resources.map((sample) => sample.cpuPercent)} />
        </article>
        <article className="resource-card gpu-card">
          <header><span><Microchip size={16} /> GPU</span><small>{gpu ? `GPU ${gpu.index}` : "Accelerator"}</small></header>
          <div className="resource-card-body"><GaugeRing value={gpu?.utilizationPercent ?? 0} color="#20b8cd" /><div><strong>{gpu ? `${gpu.utilizationPercent.toFixed(0)}%` : "No telemetry"}</strong><span>{gpu ? gpu.name : "CPU / Metal is system managed"}</span></div></div>
          <div className="resource-card-footer"><span><MemoryStick size={13} /> {gpu ? `${formatBytes(gpu.memoryUsedBytes)} / ${formatBytes(gpu.memoryTotalBytes)}` : "—"}</span><span><Thermometer size={13} /> {gpu?.temperatureCelsius != null ? `${gpu.temperatureCelsius.toFixed(0)} °C` : "—"}</span></div>
        </article>
        <article className="resource-card memory-card">
          <header><span><MemoryStick size={16} /> Memory</span><small>System RAM</small></header>
          <div className="resource-card-body"><GaugeRing value={memoryPercent} color="#f39a55" /><div><strong>{resource ? formatBytes(resource.processMemoryBytes) : "Waiting"}</strong><span>used by training</span></div></div>
          <div className="resource-card-footer"><span><HardDrive size={13} /> System {resource ? formatBytes(resource.systemMemoryUsedBytes) : "—"}</span><span>{resource ? `${memoryPercent.toFixed(0)}%` : "—"}</span></div>
        </article>
      </div>

      <div className="loss-monitor-heading"><div><p className="eyebrow">Live metrics</p><h3>Loss & validation</h3><p>Curves appear automatically for every metric emitted by the selected loss.</p></div><span className="metric-count"><Sparkles size={14} /> {metricSeries.length} series</span></div>
      {groups.size ? (
        <div className="loss-card-grid">
          {[...groups.entries()].map(([group, series]) => (
            <article className="loss-chart-card" key={group}>
              <header><div><small>Metric family</small><strong>{group}</strong></div><span>{series[0]?.points.length ?? 0} reports</span></header>
              <LossChart series={series} />
              <div className="loss-legend">
                {series.map((row, index) => {
                  const latest = row.points.at(-1);
                  return <div key={row.id}><i style={{ background: seriesColor(row, index) }} /><span><strong>{row.label}</strong><small>{row.task ? `${row.task} · ` : ""}{row.phase}</small></span><code>{latest ? formatNumber(latest.value) : "—"}</code></div>;
                })}
              </div>
            </article>
          ))}
        </div>
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
