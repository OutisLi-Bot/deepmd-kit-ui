// SPDX-License-Identifier: LGPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { formatChartAxisValue, logarithmicTicks } from "./chartScale";

describe("logarithmic chart ticks", () => {
  it("keeps nearby values in one decade visibly distinct", () => {
    const energy = logarithmicTicks(Math.log10(55), Math.log10(140));
    const force = logarithmicTicks(Math.log10(1_060), Math.log10(1_400));

    expect(new Set(energy.map(formatChartAxisValue))).toHaveLength(4);
    expect(new Set(force.map(formatChartAxisValue))).toHaveLength(4);
  });

  it("uses scientific notation only for extreme magnitudes", () => {
    expect(formatChartAxisValue(89.7)).toContain("89");
    expect(formatChartAxisValue(1_220)).toContain("1");
    expect(formatChartAxisValue(0.000_12)).toBe("1.2e-4");
  });
});
