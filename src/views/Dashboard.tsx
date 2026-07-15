// SPDX-License-Identifier: LGPL-3.0-or-later

import { ArrowRight, CheckCircle2, Cpu, FolderOpen, Gauge, HardDrive, Layers3, LoaderCircle, MemoryStick, Play, Zap } from "lucide-react";
import { useState } from "react";

import { chooseInputPath } from "../lib/studio";
import type { CommandCatalog, RuntimeReport, SystemReport, TaskSnapshot, Workflow } from "../types";
import { WorkflowIcon } from "../components/Icons";
import { StatusBadge } from "../components/TaskConsole";
import { formatBytes, SystemDetailsModal } from "../components/SystemDetailsModal";

interface DashboardProps {
  catalog: CommandCatalog;
  runtime: RuntimeReport;
  systemReport: SystemReport | null;
  tasks: TaskSnapshot[];
  workingDirectory: string;
  onWorkingDirectory: (path: string) => void;
  onWorkflow: (workflow: Workflow) => void;
  onShowTasks: () => void;
  onShowRuntime: () => void;
}

export function Dashboard({
  catalog,
  runtime,
  systemReport,
  tasks,
  workingDirectory,
  onWorkingDirectory,
  onWorkflow,
  onShowTasks,
  onShowRuntime,
}: DashboardProps) {
  const [showSystemDetails, setShowSystemDetails] = useState(false);
  const featured = catalog.commands.filter((workflow) => workflow.featured).slice(0, 3);
  const accelerator = runtime.accelerator.devices.at(0);
  const probing = Boolean(runtime.accelerator.probing);

  async function browseProject(): Promise<void> {
    const path = await chooseInputPath(true);
    if (path) onWorkingDirectory(path);
  }

  return (
    <div className="view dashboard-view">
      <section className="dashboard-hero">
        <div>
          <span className="hero-kicker"><Zap size={13} fill="currentColor" /> Deep potential workbench</span>
          <h1>Build better potentials.</h1>
          <p>Train, evaluate, inspect, and convert DeePMD models from one focused workspace.</p>
        </div>
        <div className="hero-orbit" aria-hidden="true">
          <span className="orbit-ring ring-one" />
          <span className="orbit-ring ring-two" />
          <i className="atom atom-one" />
          <i className="atom atom-two" />
          <i className="atom atom-three" />
        </div>
      </section>

      <section className="project-strip">
        <div className="project-icon"><FolderOpen size={20} /></div>
        <div className="project-copy">
          <span>Working directory</span>
          <strong title={workingDirectory}>{workingDirectory}</strong>
        </div>
        <button className="secondary-button" type="button" onClick={browseProject}>Choose folder</button>
      </section>

      <section className="dashboard-section">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">Quick start</p>
            <h2>Core workflows</h2>
          </div>
          <span className="section-caption">Ready in your isolated runtime</span>
        </div>
        <div className="quick-grid">
          {featured.map((workflow) => (
            <button
              className={`quick-card accent-border-${workflow.accent}`}
              key={workflow.name}
              type="button"
              onClick={() => onWorkflow(workflow)}
            >
              <span className={`quick-icon accent-${workflow.accent}`}>
                <WorkflowIcon name={workflow.icon} size={21} />
              </span>
              <span className="quick-copy">
                <strong>{workflow.title}</strong>
                <small>{workflow.description}</small>
              </span>
              <span className="quick-arrow"><ArrowRight size={16} /></span>
            </button>
          ))}
        </div>
      </section>

      <div className="dashboard-columns">
        <section className="dashboard-panel recent-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Activity</p>
              <h2>Recent tasks</h2>
            </div>
            <button className="text-button" type="button" onClick={onShowTasks}>View all <ArrowRight size={14} /></button>
          </div>
          {tasks.length ? (
            <div className="recent-list">
              {tasks.slice(0, 4).map((task) => (
                <button className="recent-row" key={task.id} type="button" onClick={onShowTasks}>
                  <span className="recent-command"><Play size={14} /><span><strong>{task.request.label ?? task.request.command}</strong><small>{new Date(task.createdAt).toLocaleString()}</small></span></span>
                  <StatusBadge status={task.status} />
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state compact">
              <span><Layers3 size={20} /></span>
              <strong>No tasks yet</strong>
              <p>Configure a workflow and its output will appear here.</p>
            </div>
          )}
        </section>

        <section className="dashboard-panel runtime-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">System</p>
              <h2>Runtime</h2>
            </div>
            <button className="icon-button" type="button" onClick={onShowRuntime} title="Runtime details"><Gauge size={17} /></button>
          </div>
          <button className="runtime-summary-card clickable" type="button" onClick={() => setShowSystemDetails(true)}>
            <span className="gpu-glyph"><Zap size={19} fill="currentColor" /></span>
            <div>
              <small>{probing ? "Detecting accelerator" : `${runtime.accelerator.kind.toUpperCase()} accelerator`}</small>
              <strong>{probing ? "Checking local hardware…" : accelerator?.name ?? "CPU"}</strong>
              <span>{probing ? "Workbench is ready" : accelerator ? `${formatBytes(accelerator.memory_bytes)} VRAM` : runtime.platform.machine}</span>
            </div>
            {probing ? <LoaderCircle className="runtime-check spin" size={18} /> : <CheckCircle2 className="runtime-check" size={18} />}
          </button>
          <dl className="runtime-facts hardware-facts">
            <div title={systemReport?.cpu.brand}><dt><Cpu size={12} /> CPU</dt><dd>{systemReport?.cpu.brand || "Detecting…"}</dd></div>
            <div><dt><MemoryStick size={12} /> Memory</dt><dd>{systemReport ? formatBytes(systemReport.memory.totalBytes) : "—"}</dd></div>
            <div><dt><HardDrive size={12} /> Storage</dt><dd>{systemReport ? formatBytes(systemReport.disks.reduce((total, disk) => total + disk.totalBytes, 0)) : "—"}</dd></div>
          </dl>
          <button className="system-details-link" type="button" onClick={() => setShowSystemDetails(true)}>View machine configuration <ArrowRight size={13} /></button>
        </section>
      </div>
      {showSystemDetails && <SystemDetailsModal report={systemReport} runtime={runtime} onClose={() => setShowSystemDetails(false)} />}
    </div>
  );
}
