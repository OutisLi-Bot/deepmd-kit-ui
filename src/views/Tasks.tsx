// SPDX-License-Identifier: LGPL-3.0-or-later

import { Activity, ChevronRight, Layers3, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return tasks.filter((task) =>
      !normalized ||
      task.request.command.toLowerCase().includes(normalized) ||
      task.request.label?.toLowerCase().includes(normalized) ||
      task.status.includes(normalized),
    );
  }, [query, tasks]);
  const selected = tasks.find((task) => task.id === selectedTaskId) ?? tasks.at(0);

  useEffect(() => {
    if (!selectedTaskId && tasks[0]) onSelectedTask(tasks[0].id);
  }, [onSelectedTask, selectedTaskId, tasks]);

  return (
    <div className="view tasks-view">
      <header className="page-header">
        <div>
          <p className="eyebrow">Process history</p>
          <h1>Tasks</h1>
          <p>Follow training output, inspect completed runs, and stop active processes.</p>
        </div>
        <div className="task-summary"><Activity size={16} /><strong>{tasks.filter((task) => task.status === "running").length}</strong><span>running</span></div>
      </header>

      {tasks.length ? (
        <div className="tasks-layout">
          <aside className="task-list-card">
            <label className="task-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter tasks" /></label>
            <div className="task-list">
              {filtered.map((task) => (
                <button
                  className={selected?.id === task.id ? "task-row active" : "task-row"}
                  key={task.id}
                  type="button"
                  onClick={() => onSelectedTask(task.id)}
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
            </div>
          </aside>
          <main className="task-detail">
            {selected && (selected.training
              ? <TrainingMonitor task={selected} onCancel={selected.status === "running" ? () => onCancel(selected.id) : undefined} />
              : <TaskConsole task={selected} onCancel={selected.status === "running" ? () => onCancel(selected.id) : undefined} />)}
          </main>
        </div>
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
