// SPDX-License-Identifier: LGPL-3.0-or-later

import { ArrowRight, CheckCircle2, FolderOpen, Gauge, Layers3, Play, Zap } from "lucide-react";

import { chooseInputPath } from "../lib/studio";
import type { CommandCatalog, RuntimeReport, TaskSnapshot, Workflow } from "../types";
import { WorkflowIcon } from "../components/Icons";
import { StatusBadge } from "../components/TaskConsole";

interface DashboardProps {
  catalog: CommandCatalog;
  runtime: RuntimeReport;
  tasks: TaskSnapshot[];
  workingDirectory: string;
  onWorkingDirectory: (path: string) => void;
  onWorkflow: (workflow: Workflow) => void;
  onShowTasks: () => void;
  onShowRuntime: () => void;
}

function formatMemory(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(0)} GB`;
}

export function Dashboard({
  catalog,
  runtime,
  tasks,
  workingDirectory,
  onWorkingDirectory,
  onWorkflow,
  onShowTasks,
  onShowRuntime,
}: DashboardProps) {
  const featured = catalog.commands.filter((workflow) => workflow.featured).slice(0, 3);
  const accelerator = runtime.accelerator.devices.at(0);

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
          <span className="section-caption">Driven by DeePMD {catalog.deepmd_version}</span>
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
          <div className="runtime-summary-card">
            <span className="gpu-glyph"><Zap size={19} fill="currentColor" /></span>
            <div>
              <small>{runtime.accelerator.kind.toUpperCase()} accelerator</small>
              <strong>{accelerator?.name ?? "CPU"}</strong>
              <span>{accelerator ? formatMemory(accelerator.memory_bytes) : runtime.platform.machine}</span>
            </div>
            <CheckCircle2 className="runtime-check" size={18} />
          </div>
          <dl className="runtime-facts">
            <div><dt>Python</dt><dd>{runtime.python.version}</dd></div>
            <div><dt>PyTorch</dt><dd>{runtime.accelerator.torch_version ?? "Not installed"}</dd></div>
            <div><dt>Available backends</dt><dd>{runtime.backends.filter((item) => item.available).length}</dd></div>
          </dl>
        </section>
      </div>
    </div>
  );
}
