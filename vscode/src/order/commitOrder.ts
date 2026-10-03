import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { lineCol } from '../diff/tolerance';
import { log } from '../log';
import { changedFiles, extractAt, parentOf } from '../practice/git';
import { orderByDependencies } from '../steps/deps';
import { readContentAtRef } from '../steps/scan';
import { Link } from '../target/links';
import { cacheRoot } from '../target/remotes';
import { ChangedFile, declaredNames, lf, offsetOf, orderUnits, touches, Unit, unitsOf, usesIn } from './units';

/**
 * The order of edits for the commit being typed: its units (units.ts), ordered
 * so that what a unit uses comes first. Uses are found with the language
 * extensions VS Code has: document symbols say what each unit defines, and
 * go-to-definition confirms that a name used in one unit is defined by
 * another. Language servers need real files, so the commit's version of the
 * project is extracted once into a cache folder and analysed there. Without a
 * language server for a file, names are matched as text.
 */
export interface CommitPlan {
  commit: string;
  /** Units in the order to type them. */
  units: Unit[];
  /** The commit's text of each changed file (LF). */
  after: Map<string, string>;
  /** Names each unit defines, for messages. */
  names: Map<number, string[]>;
  /** Whether a language server answered for any file. */
  languageServer: boolean;
}

const plans = new Map<string, Promise<CommitPlan | undefined>>();

/** The plan for the commit a practice folder is typing, if it's typing one. Cached per commit. */
export function planFor(link: Link): Promise<CommitPlan | undefined> | undefined {
  if (!link.pinned || !link.ref) return undefined;
  const key = `${link.targetRoot}|${link.ref}`;
  let p = plans.get(key);
  if (!p) {
    p = buildPlan(link.targetRoot, link.ref).catch((e) => {
      log.error(`Working out the edit order for ${link.ref} failed`, e);
      plans.delete(key);
      return undefined;
    });
    plans.set(key, p);
  }
  return p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function buildPlan(gitDir: string, commit: string): Promise<CommitPlan | undefined> {
  const started = Date.now();
  const parent = await parentOf(gitDir, commit);
  const files: ChangedFile[] = [];
  for (const { rel, status } of await changedFiles(gitDir, commit)) {
    if (status === 'D') continue; // a step of its own: delete the file
    const after = await readContentAtRef(gitDir, commit, rel);
    if (after?.text === undefined) continue; // binary
    const before = status === 'A' || !parent ? undefined : (await readContentAtRef(gitDir, parent, rel))?.text;
    files.push({ rel, before, after: lf(after.text) });
  }
  if (!files.length) return undefined;

  // Fallback order of files: imported files first, as the Steps view does.
  const text = new Map(files.map((f) => [f.rel, f.after]));
  const byFile = orderByDependencies(
    [...files].sort((a, b) => a.rel.localeCompare(b.rel)).map((f) => ({ kind: f.before === undefined ? ('create' as const) : ('modify' as const), path: f.rel })),
    (rel) => text.get(rel),
  ).map((s) => s.path);
  const ordered = byFile.map((rel) => files.find((f) => f.rel === rel)!);
  const units = unitsOf(ordered);

  const tree = await extractTree(gitDir, commit);
  const names = new Map<number, string[]>();
  const defs: { unit: Unit; name: string }[] = [];
  const withServer = new Set<string>();
  let symbolBudget = 4000; // ms to wait, in total, for language servers to start
  for (const f of ordered) {
    const uri = vscode.Uri.file(path.join(tree, f.rel));
    const symbols = await documentSymbols(uri, () => symbolBudget, (ms) => (symbolBudget -= ms));
    const mine = units.filter((u) => u.rel === f.rel);
    const found = symbols?.length
      ? symbols.map((s) => ({ name: s.name, at: offsetOf(f.after, s.line, s.character) }))
      : declaredNames(f.after);
    if (symbols?.length) withServer.add(f.rel);
    for (const { name, at } of found) {
      const unit = mine.find((u) => at >= u.start && at < Math.max(u.end, u.start + 1));
      if (!unit || name.length < 2) continue;
      defs.push({ unit, name });
      names.set(unit.id, [...(names.get(unit.id) ?? []), name]);
    }
  }

  // Edges: a unit that uses a name another unit defines comes after it.
  const edges: [number, number][] = [];
  let definitionCalls = 300;
  const deadline = started + 15_000;
  for (const u of units) {
    const after = text.get(u.rel)!;
    const uri = vscode.Uri.file(path.join(tree, u.rel));
    for (const v of new Set(defs.filter((d) => d.unit !== u).map((d) => d.unit))) {
      const vNames = defs.filter((d) => d.unit === v).map((d) => d.name);
      const uses = vNames.flatMap((n) => usesIn(after, u, n, 3));
      if (!uses.length) continue;
      // The name alone counts if only v defines it: without a language server, out of budget, or when it has no answer.
      const byName = () => vNames.some((n) => defs.filter((d) => d.name === n).length === 1 && usesIn(after, u, n, 1).length > 0);
      if (!withServer.has(u.rel) || definitionCalls <= 0 || Date.now() >= deadline) {
        if (byName()) edges.push([v.id, u.id]);
        continue;
      }
      let answered = false;
      for (const at of uses) {
        if (definitionCalls-- <= 0) break;
        const { line, character } = lineCol(after, at);
        const targets = await definitions(uri, new vscode.Position(line, character));
        answered ||= targets.length > 0;
        if (targets.some((t) => relIn(tree, t.uri) === v.rel && touches(v, { start: offsetOf(text.get(v.rel)!, t.line, t.character), end: offsetOf(text.get(v.rel)!, t.line, t.character) }))) {
          edges.push([v.id, u.id]);
          answered = false; // decided
          break;
        }
      }
      if (!answered && !edges.some(([f, t]) => f === v.id && t === u.id) && byName()) edges.push([v.id, u.id]);
    }
  }
  const plan = { commit, units: orderUnits(units, edges), after: text, names, languageServer: withServer.size > 0 };
  log.info(
    `Edit order for ${commit.slice(0, 7)}: ${units.length} edits, ${edges.length} dependencies, ${withServer.size ? 'language server' : 'names only'}, ${Date.now() - started} ms: ` +
      plan.units.map((u) => `${u.rel}@${u.start}${names.get(u.id) ? `(${names.get(u.id)!.join(',')})` : ''}`).join(' → '),
  );
  return plan;
}

/** The commit's version of the project, extracted once into the cache. */
async function extractTree(gitDir: string, commit: string): Promise<string> {
  const key = crypto.createHash('sha1').update(gitDir).digest('hex').slice(0, 10);
  const dir = path.join(path.dirname(cacheRoot()), 'trees', key, commit);
  const done = path.join(dir, '.slipstream-complete');
  if (!fs.existsSync(done)) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await extractAt(gitDir, commit, dir);
    fs.writeFileSync(done, '');
  }
  return fs.realpathSync.native(dir);
}

interface Spot {
  name: string;
  line: number;
  character: number;
}

/** Symbols of a file, flattened, positioned at their names. Waits a little for a language server that is still starting. */
async function documentSymbols(uri: vscode.Uri, budget: () => number, spend: (ms: number) => void): Promise<Spot[] | undefined> {
  try {
    await vscode.workspace.openTextDocument(uri);
  } catch {
    return undefined;
  }
  for (let wait = 150; ; wait *= 2) {
    const result = await vscode.commands
      .executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>('vscode.executeDocumentSymbolProvider', uri)
      .then(undefined, () => undefined);
    if (result?.length) return flatten(result);
    if (budget() < wait) return undefined;
    spend(wait);
    await sleep(wait);
  }
}

function flatten(symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[]): Spot[] {
  const out: Spot[] = [];
  const walk = (s: vscode.DocumentSymbol | vscode.SymbolInformation) => {
    const at = 'selectionRange' in s ? s.selectionRange.start : s.location.range.start;
    out.push({ name: s.name.replace(/\(.*$/, ''), line: at.line, character: at.character });
    if ('children' in s) s.children.forEach(walk);
  };
  symbols.forEach(walk);
  return out;
}

async function definitions(uri: vscode.Uri, pos: vscode.Position): Promise<{ uri: vscode.Uri; line: number; character: number }[]> {
  const result = await vscode.commands
    .executeCommand<(vscode.Location | vscode.LocationLink)[] | undefined>('vscode.executeDefinitionProvider', uri, pos)
    .then(undefined, () => undefined);
  return (result ?? []).map((d) => {
    const range = 'targetUri' in d ? (d.targetSelectionRange ?? d.targetRange) : d.range;
    return { uri: 'targetUri' in d ? d.targetUri : d.uri, line: range.start.line, character: range.start.character };
  });
}

function relIn(tree: string, uri: vscode.Uri): string | undefined {
  let file = uri.fsPath;
  try {
    file = fs.realpathSync.native(file);
  } catch {
    return undefined;
  }
  const rel = path.relative(tree, file);
  return rel.startsWith('..') || path.isAbsolute(rel) ? undefined : rel.split(path.sep).join('/');
}
