// SPDX-License-Identifier: LGPL-3.0-or-later

import {
  Activity,
  ArchiveRestore,
  ArrowRightLeft,
  BookOpenText,
  Boxes,
  Cpu,
  FileUp,
  FlaskConical,
  Info,
  Library,
  PanelTopOpen,
  Radar,
  Repeat2,
  ScanSearch,
  SlidersHorizontal,
  Snowflake,
  Sparkles,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";

import deePMDLogo from "../../app-icon.svg";

const workflowIcons: Record<string, LucideIcon> = {
  activity: Activity,
  "archive-restore": ArchiveRestore,
  "arrow-right-left": ArrowRightLeft,
  "book-open-text": BookOpenText,
  boxes: Boxes,
  cpu: Cpu,
  "file-up": FileUp,
  "flask-conical": FlaskConical,
  info: Info,
  library: Library,
  "panel-top-open": PanelTopOpen,
  radar: Radar,
  "repeat-2": Repeat2,
  "scan-search": ScanSearch,
  "sliders-horizontal": SlidersHorizontal,
  snowflake: Snowflake,
  sparkles: Sparkles,
  "terminal-square": SquareTerminal,
};

export function WorkflowIcon({ name, size = 18 }: { name: string; size?: number }) {
  const Icon = workflowIcons[name] ?? SquareTerminal;
  return <Icon aria-hidden="true" size={size} strokeWidth={1.8} />;
}

export function DeePMDMark({ size = 30 }: { size?: number }) {
  return <img alt="" aria-hidden="true" className="brand-mark" height={size} src={deePMDLogo} width={size} />;
}
