/**
 * How long the rest will take. Characters to type exclude each line's leading
 * indentation (the editor types it) and count a line break as one key.
 */
export function charsToType(text: string): number {
  return text
    .split(/\r?\n/)
    .map((line, i, all) => line.replace(/^[ \t]+/, '').length + (i < all.length - 1 ? 1 : 0))
    .reduce((a, b) => a + b, 0);
}

export const DEFAULT_WPM = 40;
/** Tab / Shift+Tab fill text far faster than typing: a nominal rate for that share. */
const TAB_CPM = 1500;

export interface Estimate {
  ms: number;
  lowMs: number;
  highMs: number;
  /** No typing data yet: based on DEFAULT_WPM. */
  guess: boolean;
}

/**
 * Time to type `chars` at `wpm`, with the share Tab usually fills taken out.
 * The range narrows as more of your typing has been measured.
 */
export function estimate(chars: number, opts: { wpm?: number; tabShare?: number; measuredChars?: number }): Estimate {
  const guess = opts.wpm === undefined;
  const cpm = (opts.wpm ?? DEFAULT_WPM) * 5;
  const tab = Math.min(Math.max(opts.tabShare ?? 0, 0), 1);
  const ms = ((chars * (1 - tab)) / cpm + (chars * tab) / TAB_CPM) * 60_000;
  const spread = guess ? 0.5 : (opts.measuredChars ?? 0) >= 1000 ? 0.1 : 0.2;
  return { ms, lowMs: ms * (1 - spread), highMs: ms * (1 + spread), guess };
}

/** "~12 min", "~25–35 min", "~1 h 20 min", "about 2 h" (a guess). */
export function formatEstimate(e: Estimate): string {
  if (e.ms < 30_000) return 'under a minute';
  if (e.guess) return `about ${formatDuration(e.ms)}`;
  const lo = formatDuration(e.lowMs);
  const hi = formatDuration(e.highMs);
  if (lo === hi) return `~${lo}`;
  // Share the unit only when both ends are plain minutes: "~24–36 min", "~48 min–1 h 12 min".
  const sameUnit = /^\d+ min$/.test(lo) && /^\d+ min$/.test(hi);
  return `~${sameUnit ? lo.replace(/ min$/, '') : lo}–${hi}`;
}

export function formatDuration(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
