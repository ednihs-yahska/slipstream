import * as path from 'path';
import { computeHunks } from '../diff/hunks';
import { filterWhitespace } from '../diff/tolerance';
import { isInside } from '../target/links';
import { definedSymbols, newSymbols, orderByDependencies } from './deps';
import {
  FileContent,
  listFilesAtRef,
  listPracticeFiles,
  listTargetFiles,
  readContent,
  readContentAtRef,
  shouldCopy,
  similarity,
} from './scan';

/**
 * One thing to do to make the practice folder match the project.
 *   create  — file exists only in the project: create it and type it
 *   modify  — both exist and differ: type the changes
 *   delete  — file exists only in the practice folder: delete it
 *   rename  — a delete + create with similar content: move it, then type the rest
 *   copy    — binary, huge or a lockfile: copy it from the project, don't type it
 */
export type StepKind = 'create' | 'modify' | 'delete' | 'rename' | 'copy';

export interface Step {
  kind: StepKind;
  /** Practice-relative path ('/'-separated). For a rename: the new path. */
  path: string;
  /** For a rename: the current (old) path in the practice folder. */
  from?: string;
  /** Changes left to type (modify), or lines to type (create). */
  changes?: number;
  /** Why, from the agent's plan. */
  reason?: string;
  /** Top-level names this step adds (from the target), e.g. ['GreetOptions', 'greet']. */
  symbols?: string[];
}

export interface StepInput {
  practiceRoot: string;
  targetRoot: string;
  lenientWhitespace: boolean;
  /** Commit whose files are the target; undefined = the working tree. */
  targetRef?: string;
  /** 'dependencies' (default): imported files first; 'path': alphabetical. */
  order?: 'dependencies' | 'path';
  /** Text of open practice documents with unsaved edits, by practice-relative path. */
  unsaved?: ReadonlyMap<string, string>;
}

const RENAME_THRESHOLD = 0.5;

export async function computeSteps(input: StepInput): Promise<Step[]> {
  const { practiceRoot, targetRoot } = input;
  // Each side must not see the other when one is nested inside the other.
  const [targetFiles, practiceFiles] = await Promise.all([
    input.targetRef
      ? listFilesAtRef(targetRoot, input.targetRef)
      : listTargetFiles(targetRoot, isInside(practiceRoot, targetRoot) ? [practiceRoot] : []),
    listPracticeFiles(practiceRoot, targetRoot, isInside(targetRoot, practiceRoot) ? [targetRoot] : []),
  ]);
  const inTarget = new Set(targetFiles);
  const inPractice = new Set(practiceFiles);

  const steps: Step[] = [];
  const creates: { rel: string; content: FileContent }[] = [];
  const deletes: { rel: string; content: FileContent }[] = [];
  const targetTexts = new Map<string, string>();

  for (const rel of new Set([...targetFiles, ...practiceFiles])) {
    const t = inTarget.has(rel) ? await targetContent(input, rel) : undefined;
    const p = inPractice.has(rel) ? await practiceContent(input, rel) : undefined;
    if (t?.text !== undefined) targetTexts.set(rel, t.text);
    if (t && p) {
      const step = modifyStep(input, rel, t, p);
      if (step) steps.push(step);
    } else if (t) {
      creates.push({ rel, content: t });
    } else if (p) {
      deletes.push({ rel, content: p });
    }
  }

  // Pair up deletes and creates that are really moves, best matches first.
  const pairs: { d: number; c: number; score: number }[] = [];
  deletes.forEach((d, di) =>
    creates.forEach((c, ci) => {
      if (d.content.text === undefined || c.content.text === undefined) return;
      const score = similarity(d.content.text, c.content.text);
      if (score >= RENAME_THRESHOLD) pairs.push({ d: di, c: ci, score });
    }),
  );
  pairs.sort((a, b) => b.score - a.score || sameName(deletes[b.d].rel, creates[b.c].rel) - sameName(deletes[a.d].rel, creates[a.c].rel));
  const usedD = new Set<number>();
  const usedC = new Set<number>();
  for (const { d, c } of pairs) {
    if (usedD.has(d) || usedC.has(c)) continue;
    usedD.add(d);
    usedC.add(c);
    const symbols = newSymbols(deletes[d].content.text, creates[c].content.text ?? '');
    steps.push({ kind: 'rename', path: creates[c].rel, from: deletes[d].rel, ...(symbols.length ? { symbols } : {}) });
  }

  creates.forEach((c, i) => {
    if (usedC.has(i)) return;
    if (shouldCopy(c.rel, c.content)) steps.push({ kind: 'copy', path: c.rel });
    else {
      const symbols = definedSymbols(c.content.text ?? '');
      steps.push({ kind: 'create', path: c.rel, changes: lineCount(c.content.text ?? ''), ...(symbols.length ? { symbols } : {}) });
    }
  });
  deletes.forEach((d, i) => {
    if (!usedD.has(i)) steps.push({ kind: 'delete', path: d.rel });
  });

  const sorted = sortSteps(steps);
  return input.order === 'path' ? sorted : orderByDependencies(sorted, (rel) => targetTexts.get(rel));
}

/** Recompute one file that exists on both sides (cheap: used while you type). */
export async function modifyStepFor(input: StepInput, rel: string): Promise<Step | undefined> {
  const t = await targetContent(input, rel);
  const p = await practiceContent(input, rel);
  return t && p ? modifyStep(input, rel, t, p) : undefined;
}

function modifyStep(input: StepInput, rel: string, t: FileContent, p: FileContent): Step | undefined {
  if (t.text === undefined || p.text === undefined || shouldCopy(rel, t)) {
    return t.binary === p.binary && t.text === p.text && t.size === p.size ? undefined : { kind: 'copy', path: rel };
  }
  if (t.text === p.text) return undefined;
  const real = p.text;
  const target = t.text.replace(/\r\n/g, '\n');
  const realLf = real.replace(/\r\n/g, '\n');
  const all = computeHunks(realLf, target);
  const hunks = input.lenientWhitespace ? filterWhitespace(realLf, all) : all;
  if (hunks.length === 0) return undefined;
  const symbols = newSymbols(real, t.text);
  return { kind: 'modify', path: rel, changes: hunks.length, ...(symbols.length ? { symbols } : {}) };
}

function targetContent(input: StepInput, rel: string): Promise<FileContent | undefined> {
  return input.targetRef
    ? readContentAtRef(input.targetRoot, input.targetRef, rel)
    : readContent(path.join(input.targetRoot, rel));
}

async function practiceContent(input: StepInput, rel: string): Promise<FileContent | undefined> {
  const unsaved = input.unsaved?.get(rel);
  if (unsaved !== undefined) return { text: unsaved, binary: false, size: unsaved.length };
  return readContent(path.join(input.practiceRoot, rel));
}

const ORDER: Record<StepKind, number> = { rename: 0, create: 1, modify: 1, copy: 2, delete: 3 };

/** Moves first (they turn into modifies), then files by path, copies, and deletes last. */
export function sortSteps(steps: Step[]): Step[] {
  return [...steps].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.path.localeCompare(b.path));
}

/** Identity of a step for progress tracking: survives the change count going down. */
export function stepKey(s: Step): string {
  return s.kind === 'rename' ? `rename:${s.from}→${s.path}` : `${s.kind === 'delete' ? 'delete' : 'file'}:${s.path}`;
}

function sameName(a: string, b: string): number {
  return path.posix.basename(a) === path.posix.basename(b) ? 1 : 0;
}

function lineCount(text: string): number {
  return text.split('\n').filter((l) => l.trim()).length;
}
