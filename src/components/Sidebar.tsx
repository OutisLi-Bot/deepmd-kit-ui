// SPDX-License-Identifier: LGPL-3.0-or-later

import { Activity, BookOpen, ChevronDown, Command, Gauge, Search, Settings2 } from "lucide-react";
import { useMemo, useState } from "react";

import type { CommandCatalog, ViewId, Workflow } from "../types";
import { DeePMDMark, WorkflowIcon } from "./Icons";

interface SidebarProps {
  catalog: CommandCatalog;
  activeView: ViewId;
  activeWorkflow: string;
  onNavigate: (view: ViewId) => void;
  onWorkflow: (workflow: Workflow) => void;
}

const primaryNavigation = [
  { id: "home" as const, label: "Overview", icon: Gauge },
  { id: "workbench" as const, label: "Workbench", icon: Command },
  { id: "tasks" as const, label: "Tasks", icon: Activity },
  { id: "runtime" as const, label: "Runtime", icon: Settings2 },
  { id: "examples" as const, label: "Examples", icon: BookOpen },
];

export function Sidebar({
  catalog,
  activeView,
  activeWorkflow,
  onNavigate,
  onWorkflow,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const grouped = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return catalog.categories
      .map((category) => ({
        category,
        workflows: catalog.commands.filter(
          (workflow) =>
            workflow.category === category &&
            (!normalized ||
              workflow.title.toLowerCase().includes(normalized) ||
              workflow.name.toLowerCase().includes(normalized)),
        ),
      }))
      .filter((group) => group.workflows.length > 0);
  }, [catalog, query]);

  function toggleCategory(category: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  return (
    <aside className="sidebar">
      <button className="brand" type="button" onClick={() => onNavigate("home")}>
        <DeePMDMark />
        <span>
          <strong>DeePMD</strong>
          <small>Studio</small>
        </span>
      </button>

      <nav className="primary-nav" aria-label="Primary navigation">
        {primaryNavigation.map(({ id, label, icon: Icon }) => (
          <button
            className={activeView === id ? "nav-item active" : "nav-item"}
            key={id}
            type="button"
            onClick={() => onNavigate(id)}
          >
            <Icon aria-hidden="true" size={17} strokeWidth={1.9} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-divider" />
      <div className="workflow-heading">
        <span>Workflows</span>
        <span className="count-pill">{catalog.commands.length}</span>
      </div>
      <label className="sidebar-search">
        <Search aria-hidden="true" size={14} />
        <input
          aria-label="Search workflows"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search commands"
        />
      </label>

      <nav className="workflow-nav" aria-label="DeePMD workflows">
        {grouped.map(({ category, workflows }) => {
          const isCollapsed = collapsed.has(category) && !query;
          return (
            <section className="workflow-group" key={category}>
              <button
                className="category-button"
                type="button"
                onClick={() => toggleCategory(category)}
                aria-expanded={!isCollapsed}
              >
                <span>{category}</span>
                <ChevronDown className={isCollapsed ? "collapsed" : ""} size={13} />
              </button>
              {!isCollapsed && (
                <div className="category-items">
                  {workflows.map((workflow) => (
                    <button
                      className={
                        activeView === "workbench" && activeWorkflow === workflow.name
                          ? "workflow-item active"
                          : "workflow-item"
                      }
                      key={workflow.name}
                      type="button"
                      onClick={() => onWorkflow(workflow)}
                      title={`dp ${workflow.name}`}
                    >
                      <span className={`workflow-mini-icon accent-${workflow.accent}`}>
                        <WorkflowIcon name={workflow.icon} size={14} />
                      </span>
                      <span>{workflow.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <span className="status-dot online" />
        <span>Local runtime ready</span>
      </div>
    </aside>
  );
}
