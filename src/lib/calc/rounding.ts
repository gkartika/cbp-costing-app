/** CEILING(value, increment) with a float-precision guard so e.g. 156000/500 doesn't land at 311.999999999. */
export function ceilingToIncrement(value: number, increment: number): number {
  if (increment <= 0) throw new Error("Rounding increment must be positive");
  const ratio = Math.round((value / increment) * 1e6) / 1e6;
  return Math.ceil(ratio) * increment;
}
