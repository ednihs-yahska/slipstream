import * as path from 'path';
import { Step } from './StepModel';

/**
 * Write what's needed before what needs it: order steps so a file comes
 * after the files it imports. Imports are read from the target text with
 * simple patterns (JS/TS relative imports, Python relative and package
 * imports): cheap, language-server-free, and good enough to sequence files.
 */

const JS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_IMPORT =
  /(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]|require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
const PY_FROM = /^\s*from\s+(\.*)([\w.]*)\s+import\s+([\w, ]+)/gm;
const PY_IMPORT = /^\s*import\s+([\w.]+)/gm;

/** Project-relative paths a file (by its target text) might import. Candidates; callers keep the ones that exist. */
export function importCandidates(rel: string, text: string): string[] {
  const dir = path.posix.dirname(rel);
  const out = new Set<string>();
  const ext = path.posix.extname(rel);
  if (JS_EXT.includes(ext) || ext === '.vue' || ext === '.svelte') {
    for (const m of text.matchAll(JS_IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const base = path.posix.normalize(path.posix.join(dir, spec));
      out.add(base);
      // TypeScript ESM writes './x.js' for './x.ts'.
      const stem = base.replace(/\.(m|c)?js$/, '');
      for (const e of JS_EXT) out.add(stem + e);
      for (const e of JS_EXT) out.add(`${base}/index${e}`);
    }
  } else if (ext === '.py') {
    for (const m of text.matchAll(PY_FROM)) {
      const [, dots, mod, names] = m;
      const root = dots ? path.posix.join(dir, ...Array(Math.max(0, dots.length - 1)).fill('..')) : '.';
      const modPath = path.posix.normalize(path.posix.join(root, ...mod.split('.').filter(Boolean)));
      out.add(`${modPath}.py`);
      out.add(`${modPath}/__init__.py`);
      // `from . import a, b` imports modules a and b.
      for (const n of names.split(',').map((s) => s.trim()).filter(Boolean)) out.add(path.posix.join(modPath, `${n}.py`));
    }
    for (const m of text.matchAll(PY_IMPORT)) {
      const modPath = m[1].split('.').join('/');
      out.add(`${modPath}.py`);
      out.add(`${modPath}/__init__.py`);
    }
  }
  return [...out].map((p) => p.replace(/^\.\//, ''));
}

/**
 * Stable topological order: a step moves after the steps whose files it
 * imports; otherwise the original order is kept. Cycles keep their original
 * order. Deletes and copies stay where they were (at the end).
 */
export function orderByDependencies(steps: readonly Step[], targetText: (rel: string) => string | undefined): Step[] {
  const movable = steps.filter((s) => s.kind !== 'delete' && s.kind !== 'copy');
  const fixed = steps.filter((s) => s.kind === 'delete' || s.kind === 'copy');
  const byPath = new Map(movable.map((s, i) => [s.path, i]));

  const needs = movable.map((s) => {
    const text = targetText(s.path);
    if (text === undefined) return new Set<number>();
    const deps = importCandidates(s.path, text)
      .map((c) => byPath.get(c))
      .filter((i): i is number => i !== undefined && movable[i] !== s);
    return new Set(deps);
  });

  const placed = new Set<number>();
  const out: Step[] = [];
  while (placed.size < movable.length) {
    // The earliest step whose dependencies are all placed; on a cycle, the earliest unplaced.
    let next = movable.findIndex((_, i) => !placed.has(i) && [...needs[i]].every((d) => placed.has(d)));
    if (next < 0) next = movable.findIndex((_, i) => !placed.has(i));
    placed.add(next);
    out.push(movable[next]);
  }
  return [...out, ...fixed];
}

const DEFINITIONS = [
  // JS/TS
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)|^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)|^(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  // Python (top level)
  /^(?:async\s+)?def\s+([A-Za-z_]\w*)|^class\s+([A-Za-z_]\w*)/gm,
  // Go, Rust (top level)
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|^(?:pub\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/gm,
];

/** Top-level names a piece of code defines, in order, without duplicates. */
export function definedSymbols(text: string): string[] {
  const found: { name: string; at: number }[] = [];
  for (const re of DEFINITIONS) {
    for (const m of text.matchAll(re)) {
      const name = m.slice(1).find(Boolean);
      if (name) found.push({ name, at: m.index ?? 0 });
    }
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.name))];
}

/** Names the target defines that the practice file doesn't yet. */
export function newSymbols(practice: string | undefined, target: string): string[] {
  const have = new Set(practice ? definedSymbols(practice) : []);
  return definedSymbols(target).filter((s) => !have.has(s));
}
