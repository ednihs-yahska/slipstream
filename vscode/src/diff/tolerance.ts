import { Hunk } from './hunks';

/** Ignore differences that are only whitespace (indentation, spacing, blank lines). */
export function filterWhitespace(real: string, hunks: readonly Hunk[]): Hunk[] {
  return hunks.filter((h) => stripWs(real.slice(h.start, h.end)) !== stripWs(h.insert));
}

export interface Ghost {
  hunk: Hunk;
  /** Text to show at the cursor. */
  text: string;
  /** Accepting replaces `replaceFrom..cursor`: extra indentation, or a mistake, you'd otherwise have to delete. */
  replaceFrom: number;
  /** What was typed instead of the expected text, when the cursor is just after a mistake. */
  mistyped?: string;
}

/** How long a mistake before the cursor can be and still keep the ghost (a word, not a rewrite). */
const MAX_MISTAKE = 40;

/**
 * The ghost for the cursor. Normally the cursor must be exactly where the
 * missing text starts. Two forgiving cases keep it showing:
 *   - only spaces/tabs stand between that point and the cursor (the editor
 *     auto-indented deeper than the target, or a stray space): accepting types
 *     over them;
 *   - you just typed something that isn't what's expected (a typo, or a
 *     different word), on this line: the ghost stays, the wrong text is struck
 *     through, and accepting replaces it. Backspace works as usual.
 */
export function ghostAt(real: string, hunks: readonly Hunk[], cursor: number): Ghost | undefined {
  for (const h of hunks) {
    if (!h.insert) continue;
    if (h.start === cursor) return { hunk: h, text: h.insert, replaceFrom: cursor };
    if (h.start < cursor && cursor <= h.end) {
      const before = real.slice(h.start, cursor);
      if (/^[ \t]+$/.test(before)) return { hunk: h, text: h.insert, replaceFrom: h.start };
      if (before.length <= MAX_MISTAKE && !/[\r\n]/.test(before)) {
        return { hunk: h, text: h.insert, replaceFrom: h.start, mistyped: before };
      }
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

/**
 * VS Code draws a multi-line ghost as virtual lines: they don't push the code
 * after the cursor down. So when a ghost inserts whole lines (it ends with a
 * line break) in front of code on the cursor's line, typing it glues the new
 * line to that code, and Enter then splits and re-indents it. Such a ghost
 * needs room: a line break after the cursor, so the code moves down first.
 */
export function needsRoom(real: string, ghost: Ghost, cursor: number): boolean {
  const h = ghost.hunk;
  if (h.end !== h.start || !/\r?\n$/.test(h.insert)) return false;
  const lineEnd = real.indexOf('\n', cursor);
  const after = real.slice(cursor, lineEnd < 0 ? real.length : lineEnd);
  return after.trim() !== '';
}
