// SPDX-License-Identifier: LGPL-3.0-or-later

import {
  Boxes,
  Cpu,
  Gauge,
  HardDrive,
  Laptop,
  LoaderCircle,
  MemoryStick,
  MonitorCog,
  Server,
  X,
  Zap,
} from "lucide-react";
import { useEffect } from "react";

import type { RuntimeReport, SystemReport } from "../types";

interface SystemDetailsModalProps {
  report: SystemReport | null;
  runtime: RuntimeReport;
  onClose: () => void;
}

export function formatBytes(bytes: number, digits = 0): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(digits)} ${units[index]}`;
}

export function SystemDetailsModal({ report, runtime, onClose }: SystemDetailsModalProps) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const accelerator = runtime.accelerator.devices.at(0);
  const probingAccelerator = Boolean(runtime.accelerator.probing);
  const usedMemory = report ? report.memory.totalBytes - report.memory.availableBytes : 0;

  return (
    <div className="system-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="system-modal" role="dialog" aria-modal="true" aria-labelledby="system-modal-title">
        <header className="system-modal-header">
          <div className="system-modal-title-icon"><MonitorCog size={22} /></div>
          <div><p className="eyebrow">Local environment</p><h2 id="system-modal-title">Machine configuration</h2><span>Hardware and application-private runtime detected by DeePMD Studio.</span></div>
          <button className="icon-button" type="button" onClick={onClose} title="Close"><X size={18} /></button>
        </header>

        {!report ? (
          <div className="system-modal-loading"><LoaderCircle className="spin" size={24} /><strong>Reading local hardware</strong><span>The workbench remains available while this completes.</span></div>
        ) : (
          <div className="system-modal-scroll">
            <div className="hardware-hero-grid">
              <article className="hardware-hero-card cpu"><span><Cpu size={19} /></span><div><small>Processor</small><strong>{report.cpu.brand || "Unknown CPU"}</strong><em>{report.cpu.physicalCores} cores · {report.cpu.logicalCores} threads</em></div></article>
              <article className="hardware-hero-card memory"><span><MemoryStick size={19} /></span><div><small>Memory</small><strong>{formatBytes(report.memory.totalBytes)}</strong><em>{formatBytes(report.memory.availableBytes)} available</em></div></article>
              <article className="hardware-hero-card gpu"><span><Zap size={19} fill="currentColor" /></span><div><small>{probingAccelerator ? "Accelerator" : `${runtime.accelerator.kind.toUpperCase()} accelerator`}</small><strong>{probingAccelerator ? "Detecting GPU…" : accelerator?.name ?? "CPU execution"}</strong><em>{probingAccelerator ? "Background inspection" : accelerator ? `${formatBytes(accelerator.memory_bytes)} VRAM` : report.operatingSystem.architecture}</em></div></article>
            </div>

            <section className="hardware-section">
              <div className="hardware-section-heading"><span><Laptop size={17} /></span><div><strong>Computer</strong><small>{report.operatingSystem.hostname}</small></div></div>
              <dl className="hardware-detail-grid">
                <div><dt>Operating system</dt><dd>{report.operatingSystem.version || report.operatingSystem.name}</dd></div>
                <div><dt>Kernel</dt><dd>{report.operatingSystem.kernel || "—"}</dd></div>
                <div><dt>Architecture</dt><dd>{report.operatingSystem.architecture}</dd></div>
                <div><dt>CPU vendor</dt><dd>{report.cpu.vendor || "—"}</dd></div>
                <div><dt>Reported clock</dt><dd>{report.cpu.frequencyMhz ? `${(report.cpu.frequencyMhz / 1000).toFixed(2)} GHz` : "—"}</dd></div>
                <div><dt>Memory in use</dt><dd>{formatBytes(usedMemory)} / {formatBytes(report.memory.totalBytes)}</dd></div>
              </dl>
            </section>

            <section className="hardware-section">
              <div className="hardware-section-heading"><span><HardDrive size={17} /></span><div><strong>Storage</strong><small>{report.disks.length} local volume{report.disks.length === 1 ? "" : "s"}</small></div></div>
              <div className="disk-list">
                {report.disks.map((disk) => {
                  const used = Math.max(0, disk.totalBytes - disk.availableBytes);
                  const percentage = disk.totalBytes ? Math.min(100, used / disk.totalBytes * 100) : 0;
                  return (
                    <article className="disk-row" key={`${disk.mountPoint}-${disk.name}`}>
                      <span className="disk-icon"><Server size={16} /></span>
                      <div><div><strong>{disk.mountPoint}</strong><small>{disk.name || disk.kind} · {disk.fileSystem}</small><em>{formatBytes(disk.availableBytes)} free of {formatBytes(disk.totalBytes)}</em></div><span className="disk-meter"><i style={{ width: `${percentage}%` }} /></span></div>
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="hardware-section runtime-stack-section">
              <div className="hardware-section-heading"><span><Boxes size={17} /></span><div><strong>DeePMD runtime</strong><small>Isolated from local Conda and Python</small></div></div>
              <div className="runtime-stack-grid">
                <div><span><Gauge size={15} /></span><small>DeePMD</small><strong>{runtime.deepmd_version}</strong></div>
                <div><span><Boxes size={15} /></span><small>Python</small><strong>{runtime.python.version}</strong></div>
                <div><span><Zap size={15} /></span><small>PyTorch / CUDA</small><strong>{runtime.accelerator.torch_version ?? "—"} · {runtime.accelerator.cuda_version ?? runtime.accelerator.kind.toUpperCase()}</strong></div>
                <div><span><Cpu size={15} /></span><small>Triton</small><strong>{runtime.triton.driver_ready ? `Ready · ${runtime.triton.version ?? "installed"}` : runtime.triton.available ? "Installed" : "Not installed"}</strong></div>
              </div>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}
