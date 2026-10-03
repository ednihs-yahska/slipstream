import { Change, diffLines, diffWordsWithSpace } from 'diff';

/**
 * One place where the real text differs from the target.
 * Offsets are into the real text: `start..end` is text you still need to
 * remove, and `insert` is text you still need to type at `start`.
 */
export interface Hunk {
  start: number;
  end: number;
  insert: string;
}

/** Identifiers and punctuation marks, so short names count as much as long ones. */
function tokens(s: string): number {
  return s.match(/[\w$]+|[^\s\w$]/g)?.length ?? 0;
}

/** Below this share of unchanged tokens, a block is a rewrite: show it as one hunk. */
const MIN_WORD_OVERLAP = 0.5;

export function computeHunks(real: string, target: string): Hunk[] {
  const parts = diffLines(real, target);
  const anchored = group(parts, 0);
  return group(unanchorTrivialLines(parts), 0)
    .flatMap((block) => {
      // Merging across a trivial line is only needed when the pieces it separates pair badly. When
      // every piece is clean (an insertion, a deletion, or a well-matched edit), keep them apart:
      // "use helper() here" and "add helper() below" stay two changes, typeable in either order.
      const end = block.start + block.removed.length;
      const pieces = anchored.filter((b) => b.start >= block.start && b.start <= end);
      return pieces.length > 1 && pieces.every(wellMatched) ? pieces : [block];
    })
    .flatMap((block) => refine(real, block).map((h) => slideToLineStart(real, h)));
}

/** A block that is an insertion, a deletion, or an edit that keeps enough of what was there. */
function wellMatched({ removed, added }: Block): boolean {
  if (!removed || !added) return true;
  const words = diffWordsWithSpace(removed, added);
  const kept = words.filter((w) => !w.added && !w.removed).reduce((n, w) => n + tokens(w.value), 0);
  return kept >= MIN_WORD_OVERLAP * tokens(removed);
}

/**
 * Lines like `}` or blank lines match almost anywhere, so a line diff happily
 * pairs the old function's closing brace with a new interface's closing brace
 * and reports "turn the function into the interface". When such a line sits
 * between two changes, treat it as part of the change instead.
 */
function unanchorTrivialLines(parts: Change[]): Change[] {
  const isChange = (p: Change | undefined) => !!p && (p.added || p.removed);
  return parts.flatMap((p, i) =>
    !isChange(p) && isChange(parts[i - 1]) && isChange(parts[i + 1]) && /^[\s{}()[\];,]*$/.test(p.value)
      ? [
          { ...p, removed: true, added: false },
          { ...p, removed: false, added: true },
        ]
      : [p],
  );
}

interface Block {
  start: number;
  removed: string;
  added: string;
}

/** Merge runs of adjacent added/removed parts into blocks, tracking real-text offsets. */
function group(parts: Change[], baseOffset: number): Block[] {
  const blocks: Block[] = [];
  let offset = baseOffset;
  let pending: Block | undefined;
  for (const part of parts) {
    if (part.added || part.removed) {
      pending ??= { start: offset, removed: '', added: '' };
      if (part.added) pending.added += part.value;
      else {
        pending.removed += part.value;
        offset += part.value.length;
      }
    } else {
      if (pending) blocks.push(pending);
      pending = undefined;
      offset += part.value.length;
    }
  }
  if (pending) blocks.push(pending);
  return blocks;
}

/**
 * Line diffs are coarse: a half-typed line shows up as "remove the whole line,
 * add the whole line", and a new block above an edited line gets merged with
 * it. Trim the common prefix/suffix at character level (so a half-typed word
 * continues where you stopped), then split the rest by words.
 */
function refine(real: string, { start, removed, added }: Block): Hunk[] {
  const max = Math.min(removed.length, added.length);
  let prefix = 0;
  while (prefix < max && removed[prefix] === added[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    removed[removed.length - 1 - suffix] === added[added.length - 1 - suffix]
  ) {
    suffix++;
  }
  const realMid = removed.slice(prefix, removed.length - suffix);
  const targetMid = added.slice(prefix, added.length - suffix);
  const midStart = start + prefix;
  const whole: Hunk = { start: midStart, end: midStart + realMid.length, insert: targetMid };
  if (!realMid || !targetMid) return [whole];

  const words = diffWordsWithSpace(realMid, targetMid);
  const kept = words.filter((w) => !w.added && !w.removed).reduce((n, w) => n + tokens(w.value), 0);
  if (kept < MIN_WORD_OVERLAP * tokens(realMid)) return [whole];

  return group(words, midStart).map((b) => ({ start: b.start, end: b.start + b.removed.length, insert: b.added }));
}

/**
 * An insertion of whole lines can land mid-line: inserting
 * "interface X {…}\n\nexport " after "export " is the same as inserting
 * "export interface X {…}\n\n" at the start of the line, and the latter is
 * how a person would type it.
 */
function slideToLineStart(real: string, h: Hunk): Hunk {
  if (h.end !== h.start || !h.insert.includes('\n')) return h;
  const lineStart = real.lastIndexOf('\n', h.start - 1) + 1;
  const lead = real.slice(lineStart, h.start);
  if (!lead || !h.insert.endsWith(lead) || h.insert[h.insert.length - lead.length - 1] !== '\n') return h;
  return { start: lineStart, end: lineStart, insert: lead + h.insert.slice(0, h.insert.length - lead.length) };
}

export function normalizeEol(text: string, eol: '\n' | '\r\n'): string {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}
