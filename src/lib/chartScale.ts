// SPDX-License-Identifier: LGPL-3.0-or-later

/**
 * Build evenly spaced tick values for a base-10 logarithmic axis.
 *
 * Parameters
 * ----------
 * logMinimum
 *     Lower axis bound expressed as log10(value).
 * logMaximum
 *     Upper axis bound expressed as log10(value).
 * count
 *     Number of ticks to generate.
 *
 * Returns
 * -------
 * number[]
 *     Positive values whose logarithms are evenly spaced across the axis.
 */
export function logarithmicTicks(logMinimum: number, logMaximum: number, count = 4): number[] {
  if (!Number.isFinite(logMinimum) || !Number.isFinite(logMaximum)) return [];
  const tickCount = Math.max(2, Math.floor(count));
  const minimum = Math.min(logMinimum, logMaximum);
  const maximum = Math.max(logMinimum, logMaximum);
  const span = Math.max(0.1, maximum - minimum);
  const center = (minimum + maximum) / 2;
  const start = center - span / 2;
  return Array.from({ length: tickCount }, (_, index) => (
    10 ** (start + (span * index) / (tickCount - 1))
  ));
}

/**
 * Format a physical chart value without collapsing nearby ticks to one decade.
 *
 * Parameters
 * ----------
 * value
 *     Positive physical value represented by an axis tick.
 *
 * Returns
 * -------
 * string
 *     A compact label with approximately three significant digits.
 */
export function formatChartAxisValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const absolute = Math.abs(value);
  if (absolute >= 100_000 || absolute < 0.01) {
    return value.toExponential(1).replace("e+", "e");
  }
  return new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 }).format(value);
}
