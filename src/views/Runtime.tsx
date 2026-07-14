// SPDX-License-Identifier: LGPL-3.0-or-later

import { useEffect, useState } from "react";
import {
  Check,
  Cpu,
  Database,
  Download,
  GitBranch,
  HardDrive,
  Laptop,
  LoaderCircle,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Tags,
  X,
  Zap,
} from "lucide-react";

import {
  checkApplicationUpdate,
  downloadApplicationUpdate,
  getRuntimeSettings,
  installRuntimeUpdate,
  launchApplicationUpdate,
  resolveRuntimeUpdate,
  restartApplication,
  setRuntimeSettings,
} from "../lib/studio";
import type {
  ApplicationDownloadResult,
  ApplicationUpdatePlan,
  RuntimeChannel,
  RuntimeInstallResult,
  RuntimeLocation,
  RuntimePlan,
  RuntimeReport,
  RuntimeSettings,
} from "../types";

interface RuntimeProps {
  report: RuntimeReport;
  location: RuntimeLocation;
}

const OFFICIAL_REPOSITORY = "https://github.com/deepmodeling/deepmd-kit.git";

const channels: Array<{
  id: RuntimeChannel;
  title: string;
  caption: string;
  icon: typeof Tags;
}> = [
  { id: "stable", title: "Stable", caption: "Latest official release tag", icon: Tags },
  { id: "beta", title: "Beta", caption: "Latest official master commit", icon: GitBranch },
  { id: "custom", title: "Custom", caption: "Your GitHub repository and ref", icon: Download },
];

function formatMemory(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function updateSetting<K extends keyof RuntimeSettings>(
  settings: RuntimeSettings,
  key: K,
  value: RuntimeSettings[K],
): RuntimeSettings {
  return { ...settings, [key]: value };
}

export function Runtime({ report, location }: RuntimeProps) {
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [plan, setPlan] = useState<RuntimePlan | null>(null);
  const [installResult, setInstallResult] = useState<RuntimeInstallResult | null>(null);
  const [busy, setBusy] = useState<"loading" | "resolving" | "installing" | null>("loading");
  const [error, setError] = useState<string | null>(null);
  const [appPlan, setAppPlan] = useState<ApplicationUpdatePlan | null>(null);
  const [appDownload, setAppDownload] = useState<ApplicationDownloadResult | null>(null);
  const [appBusy, setAppBusy] = useState<"checking" | "downloading" | null>(null);
  const [appError, setAppError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getRuntimeSettings()
      .then((loaded) => {
        if (active) setSettings(loaded);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setBusy(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const chooseChannel = (channel: RuntimeChannel): void => {
    if (!settings) return;
    setSettings({
      ...settings,
      channel,
      repository: channel === "custom" ? settings.repository : OFFICIAL_REPOSITORY,
      git_ref: channel === "stable" ? settings.git_ref : "master",
    });
    setPlan(null);
    setInstallResult(null);
    setError(null);
  };

  const resolve = async (): Promise<void> => {
    if (!settings) return;
    setBusy("resolving");
    setError(null);
    setInstallResult(null);
    try {
      await setRuntimeSettings(settings);
      setPlan(await resolveRuntimeUpdate(settings));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const install = async (): Promise<void> => {
    if (!settings) return;
    setBusy("installing");
    setError(null);
    setInstallResult(null);
    try {
      const result = await installRuntimeUpdate(settings);
      setInstallResult(result);
      setPlan(result.plan);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const customIncomplete = settings?.channel === "custom"
    && (!settings.repository.trim() || !settings.git_ref.trim());
  const disabled = !settings || busy !== null || customIncomplete;

  const checkApp = async (): Promise<void> => {
    setAppBusy("checking");
    setAppError(null);
    setAppDownload(null);
    try {
      setAppPlan(await checkApplicationUpdate(settings?.github_proxy ?? "https://gh-proxy.com"));
    } catch (reason) {
      setAppError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAppBusy(null);
    }
  };

  const downloadApp = async (): Promise<void> => {
    if (!appPlan) return;
    setAppBusy("downloading");
    setAppError(null);
    try {
      setAppDownload(await downloadApplicationUpdate(appPlan));
    } catch (reason) {
      setAppError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAppBusy(null);
    }
  };

  return (
    <div className="view runtime-view">
      <header className="page-header">
        <div>
          <p className="eyebrow">Diagnostics & updates</p>
          <h1>Runtime</h1>
          <p>The isolated Python toolchain, compute backends, and source revision used by DeePMD Studio.</p>
        </div>
        <span className="runtime-ready"><Check size={14} /> Healthy</span>
      </header>

      <div className="diagnostic-grid">
        <section className="diagnostic-card runtime-identity">
          <span className="diagnostic-icon violet"><PackageCheck size={21} /></span>
          <div><small>DeePMD-kit</small><strong>{report.deepmd_version}</strong><span>Python {report.python.version}</span></div>
        </section>
        <section className="diagnostic-card">
          <span className="diagnostic-icon blue"><Laptop size={21} /></span>
          <div><small>Platform</small><strong>{report.platform.system} {report.platform.release}</strong><span>{report.platform.machine}</span></div>
        </section>
        <section className="diagnostic-card">
          <span className="diagnostic-icon emerald"><Zap size={21} /></span>
          <div><small>Accelerator</small><strong>{report.accelerator.devices.at(0)?.name ?? "CPU"}</strong><span>{report.accelerator.available ? `${report.accelerator.kind.toUpperCase()} ready` : "CPU execution"}</span></div>
        </section>
      </div>

      <section className="runtime-manager-card">
        <div className="panel-heading runtime-manager-heading">
          <div><p className="eyebrow">Application-private environment</p><h2>DeePMD source channel</h2></div>
          <span className="isolation-badge"><ShieldCheck size={14} /> Isolated from Conda & PATH</span>
        </div>

        <div className="channel-grid" role="radiogroup" aria-label="Runtime update channel">
          {channels.map((channel) => {
            const Icon = channel.icon;
            const selected = settings?.channel === channel.id;
            return (
              <button
                aria-checked={selected}
                className={`channel-card${selected ? " selected" : ""}`}
                disabled={!settings || busy !== null}
                key={channel.id}
                onClick={() => chooseChannel(channel.id)}
                role="radio"
                type="button"
              >
                <span><Icon size={17} /></span>
                <strong>{channel.title}</strong>
                <small>{channel.caption}</small>
              </button>
            );
          })}
        </div>

        {settings && (
          <div className="runtime-source-form">
            {settings.channel === "custom" ? (
              <>
                <label>
                  <span>GitHub repository</span>
                  <input
                    onChange={(event) => {
                      setSettings(updateSetting(settings, "repository", event.target.value));
                      setPlan(null);
                    }}
                    placeholder="https://github.com/owner/deepmd-kit.git"
                    spellCheck={false}
                    value={settings.repository}
                  />
                </label>
                <label>
                  <span>Branch, tag, or commit</span>
                  <input
                    onChange={(event) => {
                      setSettings(updateSetting(settings, "git_ref", event.target.value));
                      setPlan(null);
                    }}
                    placeholder="master"
                    spellCheck={false}
                    value={settings.git_ref}
                  />
                </label>
              </>
            ) : (
              <div className="official-source">
                <span>Official source</span>
                <code>{OFFICIAL_REPOSITORY}</code>
                <small>{settings.channel === "stable" ? "GitHub's latest non-prerelease tag" : "master is resolved to an immutable commit before installation"}</small>
              </div>
            )}
            <label className="proxy-field">
              <span>GitHub proxy <small>optional</small></span>
              <input
                onChange={(event) => {
                  setSettings(updateSetting(settings, "github_proxy", event.target.value));
                  setPlan(null);
                }}
                placeholder="https://gh-proxy.com"
                spellCheck={false}
                value={settings.github_proxy}
              />
            </label>
          </div>
        )}

        <div className="runtime-manager-actions">
          <div>
            <strong>Python-only runtime</strong>
            <span>Rebuilds PT, PT-expt, and JAX inside the app; TensorFlow and LAMMPS are not included.</span>
          </div>
          <button className="secondary-button" disabled={disabled} onClick={() => void resolve()} type="button">
            {busy === "resolving" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
            Check source
          </button>
          <button className="primary-button" disabled={disabled} onClick={() => void install()} type="button">
            {busy === "installing" ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}
            {busy === "installing" ? "Rebuilding…" : "Rebuild private runtime"}
          </button>
        </div>

        {busy === "installing" && (
          <div className="runtime-notice pending" role="status">
            <LoaderCircle className="spin" size={16} />
            <div><strong>Downloading and validating a new private runtime</strong><span>The active runtime remains untouched until every import check passes.</span></div>
          </div>
        )}
        {error && <div className="runtime-error" role="alert"><X size={15} /><span>{error}</span></div>}
        {plan && !installResult && (
          <dl className="resolved-plan">
            <div><dt>Resolved ref</dt><dd>{plan.resolved_ref}</dd></div>
            <div><dt>Commit</dt><dd><code>{plan.commit}</code></dd></div>
            <div><dt>Repository</dt><dd><code>{plan.repository_slug}</code></dd></div>
          </dl>
        )}
        {installResult && (
          <div className="runtime-notice success" role="status">
            <Check size={17} />
            <div><strong>Runtime {installResult.plan.short_commit} is ready</strong><span>Restart DeePMD Studio to switch both the GUI and TUI to the new environment.</span></div>
            <button className="secondary-button" onClick={() => void restartApplication()} type="button"><RotateCcw size={14} /> Restart now</button>
          </div>
        )}
      </section>

      <section className="application-update-card">
        <div className="panel-heading">
          <div><p className="eyebrow">DeePMD Studio</p><h2>Application updates</h2></div>
          {appPlan && <span className="source-pill">v{appPlan.current_version}</span>}
        </div>
        <div className="application-update-body">
          <div className="application-update-copy">
            <strong>{appPlan?.update_available ? `Version ${appPlan.latest_version} is available` : appPlan ? "You are up to date" : "Update from the latest GitHub release"}</strong>
            <span>Downloads the platform installer through the configured GitHub proxy and verifies its SHA-256 before launch.</span>
            {appPlan?.update_available && <code>{appPlan.asset_name} · {(appPlan.bytes / 1024 ** 3).toFixed(2)} GiB</code>}
          </div>
          <button className="secondary-button" disabled={appBusy !== null} onClick={() => void checkApp()} type="button">
            {appBusy === "checking" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
            Check Studio
          </button>
          {appPlan?.update_available && !appDownload && (
            <button className="primary-button" disabled={appBusy !== null} onClick={() => void downloadApp()} type="button">
              {appBusy === "downloading" ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}
              {appBusy === "downloading" ? "Downloading…" : "Download update"}
            </button>
          )}
          {appDownload && (
            <button className="primary-button" onClick={() => void launchApplicationUpdate(appDownload.path)} type="button">
              <RotateCcw size={14} /> Install & restart
            </button>
          )}
        </div>
        {appError && <div className="runtime-error" role="alert"><X size={15} /><span>{appError}</span></div>}
        {appDownload && (
          <div className="runtime-notice success"><Check size={16} /><div><strong>Installer verified</strong><span>SHA-256 {appDownload.sha256.slice(0, 16)}… · ready to launch</span></div></div>
        )}
      </section>

      <div className="runtime-columns">
        <section className="runtime-detail-card">
          <div className="panel-heading"><div><p className="eyebrow">Compute</p><h2>Backends</h2></div><Cpu size={18} /></div>
          <div className="backend-list">
            {report.backends.map((backend) => (
              <div className="backend-row" key={backend.id}>
                <span className={backend.available ? "backend-state available" : "backend-state unavailable"}>{backend.available ? <Check size={13} /> : <X size={13} />}</span>
                <span><strong>{backend.id}</strong><small>{backend.package ?? "No package mapping"}</small></span>
                <code>{backend.available ? "available" : "not installed"}</code>
              </div>
            ))}
          </div>
        </section>

        <section className="runtime-detail-card">
          <div className="panel-heading"><div><p className="eyebrow">Hardware</p><h2>Accelerators</h2></div><Zap size={18} /></div>
          {report.accelerator.devices.length ? report.accelerator.devices.map((device) => (
            <div className="device-card" key={device.index}>
              <div className="device-visual"><span>{report.accelerator.kind.toUpperCase()}</span><Zap size={26} fill="currentColor" /></div>
              <div><small>Device {device.index}</small><strong>{device.name}</strong><span>{formatMemory(device.memory_bytes)} memory</span></div>
            </div>
          )) : <div className="empty-state compact"><span><Cpu size={20} /></span><strong>CPU runtime</strong><p>No GPU accelerator was detected.</p></div>}
          {report.accelerator.torch_version && (
            <dl className="runtime-facts device-facts">
              <div><dt>PyTorch</dt><dd>{report.accelerator.torch_version}</dd></div>
              <div><dt>CUDA</dt><dd>{report.accelerator.cuda_version ?? "N/A"}</dd></div>
              <div><dt>Triton</dt><dd>{report.triton.available ? `${report.triton.version ?? "installed"}${report.triton.driver_ready ? " · ready" : ""}` : "not installed"}</dd></div>
            </dl>
          )}
        </section>
      </div>

      <section className="paths-card">
        <div className="panel-heading"><div><p className="eyebrow">Installation</p><h2>Runtime provenance</h2></div><HardDrive size={18} /></div>
        <dl className="path-list">
          <div><dt><Database size={14} /> Python executable</dt><dd><code>{location.executable}</code></dd></div>
          <div><dt><PackageCheck size={14} /> Package root</dt><dd><code>{report.package_root}</code></dd></div>
          <div><dt>Runtime source</dt><dd><span className="source-pill">{location.source}</span></dd></div>
          {report.runtime_manifest?.runtime_channel && (
            <div><dt>Update channel</dt><dd><span className="source-pill">{report.runtime_manifest.runtime_channel}</span></dd></div>
          )}
          {report.runtime_manifest?.deepmd_source?.repository && (
            <div><dt>DeePMD repository</dt><dd><code>{report.runtime_manifest.deepmd_source.repository}</code></dd></div>
          )}
          {report.runtime_manifest?.deepmd_source?.ref && (
            <div><dt>Source ref</dt><dd><code>{report.runtime_manifest.deepmd_source.ref}</code></dd></div>
          )}
          {report.runtime_manifest?.deepmd_source?.commit && (
            <div><dt>Source commit</dt><dd><code>{report.runtime_manifest.deepmd_source.commit}</code></dd></div>
          )}
        </dl>
      </section>
    </div>
  );
}
