import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cacheDirFor, parseRemote, Remote, resolvedCommit } from './remotes';

/**
 * A practice folder is any folder containing `.slipstream/link.json`:
 *
 *   { "target": "../..", "remote": { "url": "…", "ref": "main", "path": "vscode" } }
 *
 * A file at `<practice>/src/a.ts` is typed towards `<target>/src/a.ts`.
 * The link lives with the practice folder, so it works whether that folder is
 * inside the project, elsewhere on disk, open in its own window, or cloned
 * onto another machine.
 *
 * Where the target is, in order:
 *   1. `.slipstream/link.local.json` (`{ "target": "<path>" }`): a per-machine
 *      override, never committed;
 *   2. `target`, if that path exists on this machine — and, when there is also a
 *      `remote`, only if it is a checkout of that remote (a relative `../..`
 *      in a practice repo cloned elsewhere usually exists, as some unrelated
 *      folder);
 *   3. `remote`: a git URL, fetched into a per-user cache (see remotes.ts).
 *
 * With `"ref"` (a commit), the target is that commit's version of the files,
 * read from git, instead of the working tree. `"replay"` holds the commits of
 * a range replay and which one is current. A remote target always reads a
 * commit: `ref` if set, else the commit `remote.ref` currently points at.
 */
export const META_DIR = '.slipstream';
export const LINK_FILE = path.join(META_DIR, 'link.json');
export const LOCAL_LINK_FILE = path.join(META_DIR, 'link.local.json');

export interface Replay {
  /** Commits to replay, oldest first (full hashes). */
  commits: string[];
  /** Index of the commit being typed now; `ref` is `commits[index]`. */
  index: number;
}

export interface Link {
  practiceRoot: string;
  targetRoot: string;
  /** Commit (or revision) whose files are the target; undefined = the working tree. */
  ref?: string;
  /** What `ref` was asked for, before resolving: a branch stays one session as it moves. */
  refLabel?: string;
  /** link.json pins a commit (a replay, or Start Practice from a commit's parent). */
  pinned?: boolean;
  replay?: Replay;
  remote?: Remote;
  /** Which of the three places the target came from. */
  source: 'override' | 'path' | 'remote';
}

export type LinkExtras = { ref?: string; replay?: Replay; remote?: Remote };

const cache = new Map<string, Link | null>();

export function clearLinkCache() {
  cache.clear();
  origins.clear();
}

const origins = new Map<string, string | null>();

/** Whether `dir` is a git checkout whose `origin` is `url` (cached; synchronous, as link resolution is). */
function isCheckoutOf(dir: string, url: string): boolean {
  let origin = origins.get(dir);
  if (origin === undefined) {
    try {
      origin = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
    } catch {
      origin = null;
    }
    origins.set(dir, origin);
  }
  return !!origin && sameRemote(origin, url);
}

/** Two spellings of one remote: trailing `.git` and slashes, case, and local paths normalized. */
export function sameRemote(a: string, b: string): boolean {
  const norm = (u: string) => {
    const t = u.trim().replace(/\/+$/, '').replace(/\.git$/, '');
    return /^[a-z][\w+.-]*:\/\//i.test(t) || /^[\w.-]+@[\w.-]+:/.test(t) ? t.toLowerCase() : path.resolve(t).toLowerCase();
  };
  return norm(a) === norm(b);
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

function expandPath(practiceRoot: string, p: string): string {
  const expanded = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  return path.resolve(practiceRoot, expanded);
}

export function readLink(practiceRoot: string): Link | undefined {
  const raw = readJson(path.join(practiceRoot, LINK_FILE));
  if (!raw) return undefined;
  const remote = parseRemote(raw.remote);
  const committed = typeof raw.target === 'string' && raw.target ? expandPath(practiceRoot, raw.target) : undefined;
  if (!committed && !remote) return undefined;

  const local = readJson(path.join(practiceRoot, LOCAL_LINK_FILE));
  const override = typeof local?.target === 'string' && local.target ? expandPath(practiceRoot, local.target) : undefined;

  const ref = typeof raw.ref === 'string' && raw.ref ? raw.ref : undefined;
  const replay = (raw.replay as Replay | undefined) && Array.isArray((raw.replay as Replay).commits) && typeof (raw.replay as Replay).index === 'number'
    ? (raw.replay as Replay)
    : undefined;
  const base = { practiceRoot, ...(replay ? { replay } : {}), ...(remote ? { remote } : {}), ...(ref ? { pinned: true } : {}) };

  if (override && fs.existsSync(override)) {
    return { ...base, targetRoot: override, source: 'override', ...(ref ? { ref, refLabel: ref } : {}) };
  }
  if (committed && (!remote || (fs.existsSync(committed) && isCheckoutOf(committed, remote.url)))) {
    return { ...base, targetRoot: committed, source: 'path', ...(ref ? { ref, refLabel: ref } : {}) };
  }
  // Remote: always a commit. Resolve the label to a hash when the clone exists,
  // so caches keyed by ref never serve a branch's old contents.
  const dir = cacheDirFor(remote!);
  const label = ref ?? remote!.ref ?? 'HEAD';
  return { ...base, targetRoot: dir, source: 'remote', ref: resolvedCommit(dir, label) ?? label, refLabel: label };
}

/**
 * Write a new link. The target is stored relative to the practice folder when
 * one contains the other, so the pair can move together.
 */
export function writeLink(practiceRoot: string, targetRoot: string, extras: LinkExtras = {}) {
  const rel = path.relative(practiceRoot, targetRoot);
  const nested = isInside(practiceRoot, targetRoot) || isInside(targetRoot, practiceRoot);
  const target = nested ? rel.split(path.sep).join('/') || '.' : targetRoot;
  writeLinkFile(practiceRoot, { target, ...extras });
}

/**
 * Change fields of an existing link.json in place (undefined deletes a field),
 * keeping everything else exactly as written — a committed relative target or
 * a remote must survive "next commit" on any machine.
 */
export function updateLink(practiceRoot: string, patch: Record<string, unknown>) {
  const raw = readJson(path.join(practiceRoot, LINK_FILE)) ?? {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete raw[k];
    else raw[k] = v;
  }
  writeLinkFile(practiceRoot, raw);
}

/** Point this machine at a local checkout of the project (`.slipstream/link.local.json`). */
export function writeLocalOverride(practiceRoot: string, targetRoot: string) {
  fs.mkdirSync(path.join(practiceRoot, META_DIR), { recursive: true });
  fs.writeFileSync(path.join(practiceRoot, LOCAL_LINK_FILE), JSON.stringify({ target: targetRoot }, null, 2) + '\n');
  clearLinkCache();
}

function writeLinkFile(practiceRoot: string, raw: Record<string, unknown>) {
  fs.mkdirSync(path.join(practiceRoot, META_DIR), { recursive: true });
  fs.writeFileSync(path.join(practiceRoot, LINK_FILE), JSON.stringify(raw, null, 2) + '\n');
  clearLinkCache();
}

/** The nearest practice folder containing `file`. */
export function findLink(file: string): Link | undefined {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    let link = cache.get(dir);
    if (link === undefined) {
      link = readLink(dir) ?? null;
      cache.set(dir, link);
    }
    if (link) return link;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** Where `file` should end up, or undefined if it isn't a practice file. */
export function targetPathFor(file: string): string | undefined {
  const link = findLink(file);
  if (!link) return undefined;
  const { practiceRoot, targetRoot } = link;
  if (practiceRoot === targetRoot) return undefined;
  // Slipstream's own files (and anything nested in them) aren't practice files…
  if (isInside(file, path.join(practiceRoot, META_DIR))) return undefined;
  // …nor is a target that lives inside the practice folder.
  if (isInside(targetRoot, practiceRoot) && isInside(file, targetRoot)) return undefined;
  return path.join(targetRoot, path.relative(practiceRoot, file));
}

export function isInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
}
