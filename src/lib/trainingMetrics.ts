// SPDX-License-Identifier: LGPL-3.0-or-later

import type { TrainingMetricSample, TrainingSnapshot } from "../types";

export interface TrainingMetricPoint {
  step: number;
  value: number;
}

export interface TrainingMetricSeries {
  id: string;
  key: string;
  label: string;
  group: string;
  unit: string | null;
  phase: string;
  task: string | null;
  points: TrainingMetricPoint[];
}

export interface TrainingMetricUnit {
  unit: string | null;
  scale: number;
}

const exactLabels: Record<string, string> = {
  loss: "Training loss",
  rmse: "Total RMSE",
  mae: "Total MAE",
  mse: "Mean squared error",
  mape: "Mean absolute percentage error",
  smooth_mae: "Smooth MAE",
  rmse_e: "Energy RMSE",
  mae_e: "Energy MAE",
  rmse_ea: "Energy / atom RMSE",
  rmse_ae: "Atomic energy RMSE",
  mae_ae: "Atomic energy MAE",
  rmse_f: "Force RMSE",
  mae_f: "Force MAE",
  rmse_fr: "Real-force RMSE",
  mae_fr: "Real-force MAE",
  rmse_fm: "Magnetic-force RMSE",
  mae_fm: "Magnetic-force MAE",
  rmse_pf: "Prefactor-force RMSE",
  rmse_gf: "Generalized-force RMSE",
  rmse_v: "Virial RMSE",
  mae_v: "Virial MAE",
  rmse_h: "Hessian RMSE",
  mae_h: "Hessian MAE",
  coord_l1_error: "Coordinate L1 error",
  token_error: "Token error",
  norm_loss: "Representation norm",
  l2_ener_loss: "Energy MSE",
  l2_force_loss: "Force MSE",
  l2_force_r_loss: "Real-force MSE",
  l2_force_m_loss: "Magnetic-force MSE",
  l2_pref_force_loss: "Prefactor-force MSE",
  l2_gen_force_loss: "Generalized-force MSE",
  l2_virial_loss: "Virial MSE",
  l2_atom_ener_loss: "Atomic energy MSE",
};

export function metricLabel(key: string): string {
  if (exactLabels[key]) return exactLabels[key];
  return key
    .replace(/^l2_/, "")
    .replaceAll("_", " ")
    .replace(/\brmse\b/i, "RMSE")
    .replace(/\bmae\b/i, "MAE")
    .replace(/\bmse\b/i, "MSE")
    .replace(/\bcdf\b/i, "CDF")
    .replace(/\bdos\b/i, "DOS")
    .replace(/^./, (value) => value.toUpperCase());
}

export function metricGroup(key: string, lossTypes: string[] = []): string {
  const value = key.toLowerCase();
  if (/(dos|cdf)/.test(value)) return "DOS & CDF";
  if (/(hessian|_h$)/.test(value)) return "Hessian";
  if (/(virial|_v$)/.test(value)) return "Virial";
  if (/(atom_ener|atomic_energy|_ae$)/.test(value)) return "Atomic energy";
  if (/(force|rmse_f|mae_f|_fr$|_fm$|_pf$|_gf$)/.test(value)) return "Force";
  if (/(ener|rmse_e$|mae_e$|rmse_ea)/.test(value)) return "Energy";
  if (/(dipole|polar|tensor)/.test(value)) return "Tensor";
  if (/(population|pop_|spin_|spin$)/.test(value)) return "Population & spin";
  if (/(coord|token|denoise|norm_loss)/.test(value)) return "Denoising";
  if (lossTypes.some((loss) => loss === "property")) return "Property";
  if (value === "rmse" || value === "mae" || value === "mse" || value === "mape" || value === "loss") return "Total loss";
  return "Additional loss terms";
}

/**
 * Resolve the user-facing physical unit and conversion for a DeePMD metric.
 *
 * DeePMD reports MAE and RMSE values in its native eV-based units. Studio
 * presents the most frequently inspected quantities in meV-based units while
 * leaving aggregate losses and custom metrics untouched.
 *
 * @param key - Metric key emitted by DeePMD.
 * @returns Display unit and multiplier applied to every plotted value.
 */
export function metricUnit(key: string): TrainingMetricUnit {
  const value = key.toLowerCase();
  if (!/^(?:rmse|mae)_/.test(value)) return { unit: null, scale: 1 };
  if (/(?:force_m|_fm)$/.test(value)) return { unit: "meV/μB", scale: 1_000 };
  if (/(?:hessian|_h)$/.test(value)) return { unit: "meV/Å²", scale: 1_000 };
  if (/(?:force|_f|_fr|_pf|_gf)$/.test(value)) return { unit: "meV/Å", scale: 1_000 };
  if (/(?:atom_ener|atomic_energy|_ae)$/.test(value)) return { unit: "meV", scale: 1_000 };
  if (/(?:virial|_v)$/.test(value)) return { unit: "meV/atom", scale: 1_000 };
  if (/(?:ener|_e|_ea)$/.test(value)) return { unit: "meV/atom", scale: 1_000 };
  return { unit: null, scale: 1 };
}

function seriesId(sample: TrainingMetricSample, key: string): string {
  return [key, sample.phase, sample.task ?? "default"].join("::");
}

export function buildMetricSeries(training: TrainingSnapshot): TrainingMetricSeries[] {
  const rows = new Map<string, TrainingMetricSeries>();
  for (const sample of training.metrics) {
    for (const [key, value] of Object.entries(sample.values)) {
      if (!Number.isFinite(value) || sample.phase === "total wall" || ["time", "avg", "eta", "wall_time"].includes(key.toLowerCase())) continue;
      const id = seriesId(sample, key);
      const presentation = metricUnit(key);
      const existing = rows.get(id) ?? {
        id,
        key,
        label: metricLabel(key),
        group: metricGroup(key, training.context.lossTypes),
        unit: presentation.unit,
        phase: sample.phase,
        task: sample.task,
        points: [],
      };
      const previous = existing.points.at(-1);
      const displayValue = value * presentation.scale;
      if (previous?.step === sample.step) previous.value = displayValue;
      else existing.points.push({ step: sample.step, value: displayValue });
      rows.set(id, existing);
    }
  }
  return [...rows.values()].sort((left, right) =>
    left.group.localeCompare(right.group) || left.label.localeCompare(right.label) || left.phase.localeCompare(right.phase),
  );
}

export function groupMetricSeries(series: TrainingMetricSeries[]): Map<string, TrainingMetricSeries[]> {
  const groups = new Map<string, TrainingMetricSeries[]>();
  for (const row of series) groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
  return groups;
}
