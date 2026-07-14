// SPDX-License-Identifier: LGPL-3.0-or-later

import { AlertTriangle, Moon, RefreshCw, Sun, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { DeePMDMark } from "./components/Icons";
import { Sidebar } from "./components/Sidebar";
import {
  cancelTask,
  getCatalog,
  getDefaultWorkingDirectory,
  getRuntimeLocation,
  getRuntimeReport,
  listTasks,
  startTask,
  subscribeToTaskEvents,
} from "./lib/studio";
import type {
  CommandCatalog,
  CommandRequest,
  ProcessEvent,
  RuntimeLocation,
  RuntimeReport,
  TaskSnapshot,
  ViewId,
  Workflow,
} from "./types";
import { Dashboard } from "./views/Dashboard";
import { Runtime } from "./views/Runtime";
import { Tasks } from "./views/Tasks";
import { Workbench } from "./views/Workbench";

interface AppData {
  catalog: CommandCatalog;
  runtime: RuntimeReport;
  location: RuntimeLocation;
  tasks: TaskSnapshot[];
  workingDirectory: string;
}

function applyProcessEvent(tasks: TaskSnapshot[], event: ProcessEvent): TaskSnapshot[] {
  return tasks.map((task) => {
    if (task.id !== event.taskId) return task;
    if (event.kind === "started") {
      return { ...task, status: "running", pid: event.pid };
    }
    if (event.kind === "stdout" || event.kind === "stderr" || event.kind === "error") {
      const message = `${event.kind === "stderr" ? "[stderr] " : ""}${event.message ?? ""}`;
      return { ...task, log: [...task.log, message].slice(-4000) };
    }
    if (event.kind === "finished") {
      return {
        ...task,
        status: event.cancelled ? "cancelled" : event.exitCode === 0 ? "succeeded" : "failed",
        exitCode: event.exitCode,
        finishedAt: event.timestamp,
      };
    }
    return task;
  });
}

function initialTheme(): "light" | "dark" {
  const saved = localStorage.getItem("deepmd-studio-theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  const [data, setData] = useState<AppData | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [view, setView] = useState<ViewId>("home");
  const [workflowName, setWorkflowName] = useState("train");
  const [backend, setBackend] = useState("pytorch");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [theme, setTheme] = useState(initialTheme);

  const load = useCallback(async (): Promise<void> => {
    setFatalError(null);
    try {
      const [catalog, runtime, location, tasks, workingDirectory] = await Promise.all([
        getCatalog(),
        getRuntimeReport(),
        getRuntimeLocation(),
        listTasks(),
        getDefaultWorkingDirectory(),
      ]);
      setData({ catalog, runtime, location, tasks, workingDirectory });
      const preferred = ["pytorch", "pytorch-exportable", "jax", "dpmodel"].find((candidate) =>
        runtime.backends.some((item) => item.id === candidate && item.available),
      );
      if (preferred) setBackend(preferred);
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("deepmd-studio-theme", theme);
  }, [theme]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void subscribeToTaskEvents((event) => {
      setData((current) => current ? { ...current, tasks: applyProcessEvent(current.tasks, event) } : current);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const workflow = useMemo(
    () => data?.catalog.commands.find((item) => item.name === workflowName) ?? data?.catalog.commands.at(0),
    [data, workflowName],
  );

  function selectWorkflow(selected: Workflow): void {
    setWorkflowName(selected.name);
    setView("workbench");
  }

  async function run(request: CommandRequest): Promise<void> {
    const task = await startTask(request);
    setData((current) => current ? { ...current, tasks: [task, ...current.tasks.filter((item) => item.id !== task.id)] } : current);
    setSelectedTaskId(task.id);
    setView("tasks");
  }

  async function cancel(taskId: string): Promise<void> {
    await cancelTask(taskId);
  }

  if (!data && !fatalError) {
    return (
      <div className="splash-screen">
        <DeePMDMark size={44} />
        <strong>DeePMD Studio</strong>
        <span><RefreshCw className="spin" size={14} /> Inspecting local runtime…</span>
      </div>
    );
  }

  if (!data || fatalError) {
    return (
      <div className="fatal-screen">
        <span><AlertTriangle size={24} /></span>
        <h1>Runtime unavailable</h1>
        <p>{fatalError ?? "DeePMD Studio could not initialize."}</p>
        <button className="primary-button" type="button" onClick={() => void load()}><RefreshCw size={15} /> Try again</button>
      </div>
    );
  }

  const pageTitle = view === "home" ? "Overview" : view === "workbench" ? workflow?.title ?? "Workbench" : view === "tasks" ? "Tasks" : "Runtime";
  const runningCount = data.tasks.filter((task) => task.status === "running").length;

  return (
    <div className="app-shell">
      <Sidebar
        catalog={data.catalog}
        activeView={view}
        activeWorkflow={workflow?.name ?? ""}
        onNavigate={setView}
        onWorkflow={selectWorkflow}
      />
      <div className="app-main">
        <header className="topbar">
          <div className="topbar-title"><span>DeePMD Studio</span><i>/</i><strong>{pageTitle}</strong></div>
          <div className="topbar-actions">
            {runningCount > 0 && <button className="running-chip" type="button" onClick={() => setView("tasks")}><span /><strong>{runningCount}</strong> running</button>}
            <span className="accelerator-chip"><Zap size={13} fill="currentColor" /> {data.runtime.accelerator.kind.toUpperCase()}</span>
            <button className="icon-button theme-button" type="button" onClick={() => setTheme((current) => current === "light" ? "dark" : "light")} title={`Use ${theme === "light" ? "dark" : "light"} theme`}>
              {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
            </button>
          </div>
        </header>

        <div className="view-scroll">
          {view === "home" && (
            <Dashboard
              catalog={data.catalog}
              runtime={data.runtime}
              tasks={data.tasks}
              workingDirectory={data.workingDirectory}
              onWorkingDirectory={(workingDirectory) => setData({ ...data, workingDirectory })}
              onWorkflow={selectWorkflow}
              onShowTasks={() => setView("tasks")}
              onShowRuntime={() => setView("runtime")}
            />
          )}
          {view === "workbench" && workflow && (
            <Workbench
              workflow={workflow}
              backends={data.catalog.backends}
              runtime={data.runtime}
              runtimeLocation={data.location}
              backend={backend}
              workingDirectory={data.workingDirectory}
              onBackend={setBackend}
              onWorkingDirectory={(workingDirectory) => setData({ ...data, workingDirectory })}
              onRun={run}
            />
          )}
          {view === "tasks" && (
            <Tasks
              tasks={data.tasks}
              selectedTaskId={selectedTaskId}
              onSelectedTask={setSelectedTaskId}
              onCancel={cancel}
            />
          )}
          {view === "runtime" && <Runtime report={data.runtime} location={data.location} />}
        </div>
      </div>
    </div>
  );
}
