// SPDX-License-Identifier: LGPL-3.0-or-later

import { Activity, ChevronDown, ChevronRight, Layers3, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { StatusBadge, TaskConsole } from "../components/TaskConsole";
import { TrainingMonitor } from "../components/TrainingMonitor";
import type { TaskSnapshot } from "../types";

interface TasksProps {
  tasks: TaskSnapshot[];
  selectedTaskId: string | null;
  onSelectedTask: (taskId: string) => void;
  onCancel: (taskId: string) => Promise<void>;
}

export function Tasks({ tasks, selectedTaskId, onSelectedTask, onCancel }: TasksProps) {
  const [query, setQuery] = useState("");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return tasks.filter((task) =>
      !normalized ||
      task.request.command.toLowerCase().includes(normalized) ||
      task.request.label?.toLowerCase().includes(normalized) ||
      task.request.workingDirectory.toLowerCase().includes(normalized) ||
      task.status.includes(normalized),
    );
  }, [query, tasks]);
  const selected = tasks.find((task) => task.id === selectedTaskId) ?? tasks.at(0);
  const runningCount = tasks.filter((task) => task.status === "running").length;

  useEffect(() => {
    if (!selectedTaskId && tasks[0]) onSelectedTask(tasks[0].id);
  }, [onSelectedTask, selectedTaskId, tasks]);

  useEffect(() => {
    if (!switcherOpen) return undefined;
    function closeOutside(event: PointerEvent): void {
      if (!switcherRef.current?.contains(event.target as Node)) setSwitcherOpen(false);
    }
    function closeOnEscape(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") setSwitcherOpen(false);
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [switcherOpen]);

  function chooseTask(taskId: string): void {
    onSelectedTask(taskId);
    setSwitcherOpen(false);
  }

  return (
    <div className="view tasks-view">
      <header className="page-header tasks-header">
        <div>
          <p className="eyebrow">Process history</p>
          <h1>Tasks</h1>
          <p>Follow training output, inspect completed runs, and stop active processes.</p>
        </div>
        {tasks.length > 0 && (
          <div className="task-switcher" ref={switcherRef}>
            <button
              aria-expanded={switcherOpen}
              className="task-switcher-trigger"
              type="button"
              onClick={() => setSwitcherOpen((current) => !current)}
            >
              <span className="task-switcher-icon"><Layers3 size={16} /></span>
              <span><small>{tasks.length === 1 ? "Current task" : `${tasks.length} local tasks`}</small><strong>{selected?.request.label ?? selected?.request.command ?? "Choose task"}</strong></span>
              {runningCount > 0 && <i>{runningCount} running</i>}
              <ChevronDown className={switcherOpen ? "open" : ""} size={15} />
            </button>
            {switcherOpen && (
              <aside className="task-switcher-popover">
                <header><span><Activity size={15} /><strong>Task history</strong></span><button type="button" onClick={() => setSwitcherOpen(false)} title="Close task history"><X size={14} /></button></header>
                <label className="task-search"><Search size={15} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter label, status, or folder" /></label>
                <div className="task-list">
                  {filtered.map((task) => (
                    <button
                      className={selected?.id === task.id ? "task-row active" : "task-row"}
                      key={task.id}
                      type="button"
                      onClick={() => chooseTask(task.id)}
                    >
                      <span className="task-row-copy">
                        <strong>{task.request.label ?? task.request.command}</strong>
                        <small>{task.request.backend ?? "auto"} · {new Date(task.createdAt).toLocaleTimeString()}</small>
                        {task.training?.context.totalSteps && (
                          <span className="task-mini-progress"><i style={{ width: `${Math.min(100, task.training.currentStep / task.training.context.totalSteps * 100)}%` }} /></span>
                        )}
                      </span>
                      <StatusBadge status={task.status} />
                      <ChevronRight size={14} />
                    </button>
                  ))}
                  {!filtered.length && <div className="task-switcher-empty">No task matches “{query}”.</div>}
                </div>
              </aside>
            )}
          </div>
        )}
      </header>

      {tasks.length ? (
        <main className="task-detail">
          {selected && (selected.training
            ? <TrainingMonitor task={selected} onCancel={selected.status === "running" ? () => onCancel(selected.id) : undefined} />
            : <TaskConsole task={selected} onCancel={selected.status === "running" ? () => onCancel(selected.id) : undefined} />)}
        </main>
      ) : (
        <div className="empty-state large">
          <span><Layers3 size={28} /></span>
          <h2>No tasks yet</h2>
          <p>Start a workflow from the Workbench. Its live process output will be collected here.</p>
        </div>
      )}
    </div>
  );
}
