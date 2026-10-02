export function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    throw new RangeError(`min (${min}) is greater than max (${max})`);
  }
  return Math.min(Math.max(value, min), max);
}

export function sum(values: readonly number[]): number {
  return values.reduce((total, v) => total + v, 0);
}
