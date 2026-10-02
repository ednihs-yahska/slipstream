import * as fs from 'fs';
import * as path from 'path';
import { META_DIR } from '../target/links';
import { Step } from './StepModel';

/**
 * The agent's plan: `.slipstream/plan.md` in the project. An ordered list of
 * the files to touch, each with a one-line reason, in the order a person
 * should write them. Forgiving about format:
 *
 *   # Plan: Add greeting options
 *   1. `src/types.ts` — add `GreetOptions`, used by `greet()`
 *   2. `src/greet.ts`: accept options
 *   - Delete `src/legacy.ts` (replaced by the options)
 *
 * Any list item whose first code span looks like a path is an entry.
 */
export const PLAN_FILE = path.join(META_DIR, 'plan.md');

export interface PlanEntry {
  path: string;
  reason?: string;
}

export interface Plan {
  title?: string;
  entries: PlanEntry[];
}

const LIST_ITEM = /^\s*(?:\d+[.)]|[-*+])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const CODE_SPAN = /`([^`]+)`/;
const LOOKS_LIKE_PATH = /^[\w@.~-][^\s]*$/;

export function parsePlan(markdown: string): Plan {
  const plan: Plan = { entries: [] };
  const byPath = new Map<string, PlanEntry>();
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#\s+(.*)$/.exec(line);
    if (heading && !plan.title) {
      plan.title = heading[1].replace(/^plan\s*[:—–-]\s*/i, '').trim() || undefined;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (!item) continue;
    const text = item[1];
    const code = CODE_SPAN.exec(text);
    if (!code) continue;
    const p = normalize(code[1]);
    if (!LOOKS_LIKE_PATH.test(p) || !(p.includes('/') || p.includes('.'))) continue;

    const after = clean(text.slice(code.index + code[0].length));
    const before = clean(text.slice(0, code.index));
    const reason = [before, after].filter(Boolean).join(' ') || undefined;
    const existing = byPath.get(p);
    if (existing) {
      if (reason) existing.reason = existing.reason ? `${existing.reason}; ${reason}` : reason;
    } else {
      const entry: PlanEntry = { path: p, reason };
      byPath.set(p, entry);
      plan.entries.push(entry);
    }
  }
  return plan;
}

export function readPlan(targetRoot: string): Plan | undefined {
  try {
    const plan = parsePlan(fs.readFileSync(path.join(targetRoot, PLAN_FILE), 'utf8'));
    return plan.entries.length > 0 || plan.title ? plan : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Put planned steps first, in the plan's order, with their reasons; anything
 * the plan doesn't mention keeps its usual order after them. A move matches
 * the plan by its new or its old path.
 */
export function applyPlan(steps: readonly Step[], plan: Plan | undefined): Step[] {
  if (!plan || plan.entries.length === 0) return [...steps];
  const index = new Map(plan.entries.map((e, i) => [e.path, i]));
  const rank = (s: Step) => Math.min(index.get(s.path) ?? Infinity, s.from !== undefined ? (index.get(s.from) ?? Infinity) : Infinity);
  return steps
    .map((s, i) => ({ s, i, r: rank(s) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ s, r }) => (r === Infinity ? s : { ...s, reason: plan.entries[r].reason }));
}

function normalize(p: string): string {
  return p.trim().replace(/[\\/]+/g, '/').replace(/^\.\//, '');
}

/** Strip list-ish separators and markdown emphasis around a reason. */
function clean(s: string): string {
  return s
    .replace(/^[\s:—–-]+|[\s:—–-]+$/g, '')
    .replace(/^\((.*)\)$/, '$1')
    .replace(/\*\*|__/g, '')
    .trim();
}
