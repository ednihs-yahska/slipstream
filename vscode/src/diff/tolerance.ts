import { Hunk } from './hunks';

/** Ignore differences that are only whitespace (indentation, spacing, blank lines). */
export function filterWhitespace(real: string, hunks: readonly Hunk[]): Hunk[] {
  return hunks.filter((h) => stripWs(real.slice(h.start, h.end)) !== stripWs(h.insert));
}

export interface Ghost {
  hunk: Hunk;
  /** Text to show at the cursor. */
  text: string;
  /** Accepting replaces `replaceFrom..cursor`: extra indentation you'd otherwise have to delete. */
  replaceFrom: number;
}

/**
 * The ghost for the cursor. Normally the cursor must be exactly where the
 * missing text starts; but if only spaces/tabs stand between that point and
 * the cursor (the editor auto-indented deeper than the target, or you typed a
 * stray space), show the ghost anyway and type over them on accept.
 */
export function ghostAt(real: string, hunks: readonly Hunk[], cursor: number): Ghost | undefined {
  for (const h of hunks) {
    if (!h.insert) continue;
    if (h.start === cursor) return { hunk: h, text: h.insert, replaceFrom: cursor };
    if (h.start < cursor && cursor <= h.end && /^[ \t]+$/.test(real.slice(h.start, cursor))) {
      return { hunk: h, text: h.insert, replaceFrom: h.start };
    }
  }
  return undefined;
}

/**
 * Where hunk `h` sits in the target text. `all` must be every hunk from the
 * same diff (unfiltered), in order, since each earlier hunk shifts offsets.
 */
export function targetRange(all: readonly Hunk[], h: Hunk): { start: number; end: number } {
  let shift = 0;
  for (const x of all) {
    if (x === h) return { start: h.start + shift, end: h.start + shift + h.insert.length };
    shift += x.insert.length - (x.end - x.start);
  }
  throw new Error('hunk not in diff');
}

/** Line/character of an offset, independent of line-ending style. */
export function lineCol(text: string, offset: number): { line: number; character: number } {
  const before = text.slice(0, offset);
  const line = (before.match(/\n/g) ?? []).length;
  return { line, character: offset - (before.lastIndexOf('\n') + 1) };
}

function stripWs(s: string): string {
  return s.replace(/\s+/g, '');
}
