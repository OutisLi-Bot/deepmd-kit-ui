// SPDX-License-Identifier: LGPL-3.0-or-later

import { Ban, Check, CircleEllipsis, Clock3, Copy, LoaderCircle, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { TaskSnapshot, TaskStatus } from "../types";

const statusLabels: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const Icon =
    status === "running"
      ? LoaderCircle
      : status === "succeeded"
        ? Check
        : status === "failed"
          ? X
          : status === "cancelled"
            ? Ban
            : CircleEllipsis;
  return (
    <span className={`status-badge status-${status}`}>
      <Icon className={status === "running" ? "spin" : ""} size={13} />
      {statusLabels[status]}
    </span>
  );
}

interface TaskConsoleProps {
  task: TaskSnapshot;
  onCancel?: () => void;
}

export function TaskConsole({ task, onCancel }: TaskConsoleProps) {
  const [copied, setCopied] = useState(false);
  const command = useMemo(() => {
    const parts = ["dp"];
    if (task.request.backend) parts.push(`--backend ${task.request.backend}`);
    parts.push(task.request.command, ...task.request.args);
    return parts.join(" ");
  }, [task]);

  async function copyLog(): Promise<void> {
    await navigator.clipboard.writeText(task.log.join("\n"));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <section className="task-console-card">
      <header className="console-header">
        <div>
          <span className="console-lights"><i /><i /><i /></span>
          <span className="console-title">{task.request.label ?? task.request.command}</span>
        </div>
        <div className="console-actions">
          <StatusBadge status={task.status} />
          {task.status === "running" && onCancel && (
            <button className="console-button danger" type="button" onClick={onCancel}>Stop</button>
          )}
          <button className="console-button" type="button" onClick={copyLog}>
            <Copy size={13} /> {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </header>
      <div className="console-command"><span>$</span> {command}</div>
      <pre className="console-output" aria-live="polite">
        {task.log.length ? task.log.join("\n") : "Waiting for process output…"}
        {task.status === "running" && <span className="terminal-cursor">▋</span>}
      </pre>
      <footer className="console-footer">
        <span><Clock3 size={12} /> Started {new Date(task.createdAt).toLocaleString()}</span>
        {task.pid && <span>PID {task.pid}</span>}
        {task.exitCode != null && <span>Exit code {task.exitCode}</span>}
      </footer>
    </section>
  );
}
