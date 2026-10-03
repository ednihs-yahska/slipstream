import { computeHunks, Hunk } from '../diff/hunks';
import { filterWhitespace, targetRange } from '../diff/tolerance';

/**
 * Edit order for one commit. A commit's changes are cut into *units*: runs of
 * changed lines, as the diff from the commit's parent to the commit finds
 * them, merged when only whitespace separates them. Units are ordered as a
 * DAG: a unit comes after the units that define what it uses (see
 * symbols.ts for how uses are found). Everything here is plain text; offsets
 * are into the commit's version of a file, with LF line endings.
 */
export interface Unit {
  id: number;
  /** Practice-relative path. */
  rel: string;
  /** Range in the commit's text of the file. Zero-length for a pure deletion. */
  start: number;
  end: number;
  /** The file doesn't exist in the commit's parent. */
  created: boolean;
  /** Position of the file in the fallback file order. */
  fileIndex: number;
}

export interface ChangedFile {
  rel: string;
  /** The parent's text; undefined if the commit creates the file. */
  before?: string;
  /** The commit's text. */
  after: string;
}

export const lf = (s: string) => s.replace(/\r\n/g, '\n');

/** Units of a commit, in file order, then position. `files` is in the fallback file order. */
export function unitsOf(files: readonly ChangedFile[]): Unit[] {
  const units: Unit[] = [];
  files.forEach((f, fileIndex) => {
    const before = lf(f.before ?? '');
    const after = lf(f.after);
    const all = computeHunks(before, after);
    let last: Unit | undefined;
    for (const h of all) {
      const r = targetRange(all, h);
      // Only whitespace between this change and the last one: one unit ("contiguous").
      if (last && /^[ \t]*\n?[ \t]*$/.test(after.slice(last.end, r.start))) {
        last.end = Math.max(last.end, r.end);
        continue;
      }
      last = { id: units.length, rel: f.rel, start: r.start, end: r.end, created: f.before === undefined, fileIndex };
      units.push(last);
    }
  });
  return units;
}

/** Whether a target range touches a unit (ranges are inclusive, so zero-length ones count). */
export const touches = (u: { start: number; end: number }, r: { start: number; end: number }) => r.start <= u.end && r.end >= u.start;

/**
 * Hunks still to type, between a practice text and the commit's text, each
 * with its range in the commit's text. Undefined practice: the file doesn't
 * exist yet.
 */
export function remaining(practice: string | undefined, after: string, lenient: boolean): { hunk: Hunk; range: { start: number; end: number } }[] {
  const real = lf(practice ?? '');
  const target = lf(after);
  const all = computeHunks(real, target);
  const kept = lenient ? filterWhitespace(real, all) : all;
  return kept.map((hunk) => ({ hunk, range: targetRange(all, hunk) }));
}

/** Units that still have something to type, given each file's current practice text. */
export function pendingUnits(
  units: readonly Unit[],
  after: ReadonlyMap<string, string>,
  practice: (rel: string) => string | undefined,
  lenient: boolean,
): Set<number> {
  const pending = new Set<number>();
  for (const rel of new Set(units.map((u) => u.rel))) {
    const text = practice(rel);
    const left = remaining(text, after.get(rel) ?? '', lenient);
    for (const u of units.filter((x) => x.rel === rel)) {
      if (text === undefined || left.some((l) => touches(u, l.range))) pending.add(u.id);
    }
  }
  return pending;
}

/**
 * Order units so each comes after the units it depends on (`edges`: [from,
 * to] means `from` first). Ties, and the members of a cycle, keep file order
 * and then position. Deterministic.
 */
export function orderUnits(units: readonly Unit[], edges: readonly (readonly [number, number])[]): Unit[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const key = (u: Unit) => [u.fileIndex, u.start, u.id];
  const before = (a: Unit, b: Unit) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  };
  const out = new Map<number, number[]>(units.map((u) => [u.id, []]));
  for (const [from, to] of edges) if (from !== to && byId.has(from) && byId.has(to)) out.get(from)!.push(to);

  // Cycles become one group (Tarjan's strongly connected components).
  const comp = new Map<number, number>();
  const groups: Unit[][] = [];
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const stack: number[] = [];
  const onStack = new Set<number>();
  let counter = 0;
  const visit = (v: number) => {
    index.set(v, counter);
    low.set(v, counter++);
    stack.push(v);
    onStack.add(v);
    for (const w of out.get(v)!) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const group: Unit[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.set(w, groups.length);
        group.push(byId.get(w)!);
      } while (w !== v);
      groups.push(group.sort(before));
    }
  };
  for (const u of [...units].sort(before)) if (!index.has(u.id)) visit(u.id);

  // Kahn over the groups, always taking the earliest available one.
  const needs = groups.map(() => new Set<number>());
  for (const [from, tos] of out) for (const to of tos) if (comp.get(from) !== comp.get(to)) needs[comp.get(to)!].add(comp.get(from)!);
  const placed = new Set<number>();
  const result: Unit[] = [];
  while (placed.size < groups.length) {
    let next = -1;
    for (let g = 0; g < groups.length; g++) {
      if (placed.has(g) || [...needs[g]].some((d) => !placed.has(d))) continue;
      if (next < 0 || before(groups[g][0], groups[next][0]) < 0) next = g;
    }
    placed.add(next);
    result.push(...groups[next]);
  }
  return result;
}

/** Where a name is used inside a unit: offsets in the commit's text of its file. */
export function usesIn(after: string, unit: Unit, name: string, max = 5): number[] {
  const text = after.slice(unit.start, unit.end);
  const re = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w$])`, 'g');
  const found: number[] = [];
  for (let m = re.exec(text); m && found.length < max; m = re.exec(text)) found.push(unit.start + m.index);
  return found;
}

/** Offset of a line and column in LF text. */
export function offsetOf(text: string, line: number, character: number): number {
  let at = 0;
  for (let i = 0; i < line; i++) {
    const nl = text.indexOf('\n', at);
    if (nl < 0) return text.length;
    at = nl + 1;
  }
  return Math.min(at + character, text.length);
}

/** Without a language server: declarations recognisable in most languages. */
export function declaredNames(text: string): { name: string; at: number }[] {
  const re = /\b(?:function\*?|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|module|namespace)\s+([A-Za-z_$][\w$]*)/g;
  const out: { name: string; at: number }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ name: m[1], at: m.index + m[0].length - m[1].length });
  return out;
}
