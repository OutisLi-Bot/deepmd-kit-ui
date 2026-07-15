// SPDX-License-Identifier: LGPL-3.0-or-later

import { describe, expect, it } from "vitest";

import type { TrainingSnapshot } from "../types";
import { buildMetricSeries, metricGroup, metricLabel } from "./trainingMetrics";

describe("training metric presentation", () => {
  it("classifies physical and specialized loss metrics", () => {
    expect(metricGroup("rmse_e")).toBe("Energy");
    expect(metricGroup("rmse_fm")).toBe("Force");
    expect(metricGroup("rmse_global_dos")).toBe("DOS & CDF");
    expect(metricGroup("rmse_h")).toBe("Hessian");
    expect(metricGroup("rmse")).toBe("Total loss");
    expect(metricGroup("l2_virial_loss")).toBe("Virial");
    expect(metricLabel("rmse_local_dipole")).toBe("RMSE local dipole");
  });

  it("keeps train, validation, and multi-task curves separate", () => {
    const training: TrainingSnapshot = {
      context: { inputPath: "input.json", totalSteps: 100, modelType: "dpa4", lossTypes: ["ener"] },
      currentStep: 10,
      etaSeconds: null,
      stepTimeSeconds: null,
      resources: [],
      metrics: [
        { step: 10, phase: "train", task: "water", values: { rmse_e: 0.2 }, learningRate: 0.001, timestamp: "2026-01-01T00:00:00Z" },
        { step: 10, phase: "validation", task: "water", values: { rmse_e: 0.3 }, learningRate: null, timestamp: "2026-01-01T00:00:00Z" },
      ],
    };
    const series = buildMetricSeries(training);
    expect(series).toHaveLength(2);
    expect(new Set(series.map((item) => item.phase))).toEqual(new Set(["train", "validation"]));
    expect(series.every((item) => item.task === "water")).toBe(true);
  });

  it("does not present timing telemetry as a loss curve", () => {
    const training: TrainingSnapshot = {
      context: { inputPath: "input.json", totalSteps: 100, modelType: "dpa4", lossTypes: ["ener"] },
      currentStep: 10,
      etaSeconds: 90,
      stepTimeSeconds: 0.04,
      resources: [],
      metrics: [
        { step: 10, phase: "total wall", task: null, values: { time: 2, avg: 0.04, eta: 90 }, learningRate: null, timestamp: "2026-01-01T00:00:00Z" },
      ],
    };
    expect(buildMetricSeries(training)).toEqual([]);
  });
});
