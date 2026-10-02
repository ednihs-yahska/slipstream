/**
 * Typing speed from real keystrokes. Slipstream sees document changes, not
 * keys, so each change is classified by what a single key can produce:
 *
 *   one character                        → a key (1 character)
 *   Enter + the editor's auto-indent     → a key (1 character)
 *   an auto-closed pair: (), [], {}, "", ''… → a key (1 character)
 *   a pure deletion (Backspace, Delete)  → a correction
 *   anything else                        → not typing: a paste, snippet,
 *                                          completion, format or indent
 *
 * Tab / Shift+Tab accepts and undo/redo are excluded before classification.
 * Multi-cursor typing (the same keystroke at several places) counts once.
 */
export interface Change {
  text: string;
  rangeLength: number;
}

export interface Classified {
  keys: number;
  chars: number;
  corrections: number;
}

const NONE: Classified = { keys: 0, chars: 0, corrections: 0 };
const PAIRS = new Set(['()', '[]', '{}', '""', "''", '``', '<>']);

export function classify(changes: readonly Change[], opts: { accepted?: boolean; undoRedo?: boolean } = {}): Classified {
  if (opts.accepted || opts.undoRedo || changes.length === 0) return NONE;
  // Multi-cursor: every cursor receives the same text from one keystroke.
  if (changes.length > 1 && !changes.every((c) => c.text === changes[0].text)) return NONE;
  const { text, rangeLength } = changes[0];
  if (text === '') return rangeLength > 0 ? { keys: 1, chars: 0, corrections: 1 } : NONE;
  if (/^\r?\n[ \t]*(\r?\n[ \t]*)?$/.test(text)) return { keys: 1, chars: 1, corrections: 0 }; // Enter (+ auto-indent, + brace split)
  if (text.length === 1 || (text.length === 2 && text !== '\r\n' && [...text].length === 1)) return { keys: 1, chars: 1, corrections: 0 };
  if (PAIRS.has(text)) return { keys: 1, chars: 1, corrections: 0 };
  return NONE;
}

export interface SpeedSnapshot {
  keys: number;
  chars: number;
  corrections: number;
  /** Time spent typing: the gaps between keys, with idle gaps left out. */
  activeMs: number;
}

/** Characters per minute → words per minute (the standard five characters per word). */
export function wpm(chars: number, activeMs: number): number | undefined {
  if (activeMs < 5_000 || chars < 10) return undefined; // too little to say
  return chars / 5 / (activeMs / 60_000);
}

/**
 * Accumulates keystrokes for one session. Active time grows by the gap since
 * the previous key, unless the gap is longer than `idleMs` — reading, thinking
 * and coffee don't count against the speed.
 */
export class SpeedMeter {
  private last?: number;
  private readonly recent: { t: number; chars: number; gap: number }[] = [];

  constructor(
    public totals: SpeedSnapshot = { keys: 0, chars: 0, corrections: 0, activeMs: 0 },
    private readonly idleMs = 5_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  record(c: Classified) {
    if (c.keys === 0) return;
    const t = this.now();
    const gap = this.last === undefined || t - this.last > this.idleMs ? 0 : t - this.last;
    this.last = t;
    this.totals = {
      keys: this.totals.keys + c.keys,
      chars: this.totals.chars + c.chars,
      corrections: this.totals.corrections + c.corrections,
      activeMs: this.totals.activeMs + gap,
    };
    this.recent.push({ t, chars: c.chars, gap });
    while (this.recent.length && t - this.recent[0].t > 5 * 60_000) this.recent.shift();
  }

  /** Speed over the last `windowMs` of wall time (active time only); falls back to nothing. */
  current(windowMs = 60_000): number | undefined {
    const since = this.now() - windowMs;
    const inWindow = this.recent.filter((r) => r.t >= since);
    return wpm(
      inWindow.reduce((n, r) => n + r.chars, 0),
      inWindow.reduce((n, r) => n + r.gap, 0),
    );
  }

  average(): number | undefined {
    return wpm(this.totals.chars, this.totals.activeMs);
  }
}

/** Corrections as a share of keystrokes, 0..1. */
export function correctionRate(s: SpeedSnapshot): number | undefined {
  return s.keys >= 20 ? s.corrections / s.keys : undefined;
}
