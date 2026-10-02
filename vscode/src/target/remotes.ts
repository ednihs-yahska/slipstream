import { execFile, execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

/**
 * Remote targets: a practice folder's project can be a git URL. Slipstream
 * keeps a bare clone in a per-user cache and reads files from it with the
 * same ls-tree / cat-file code a replay uses — so the extension and the MCP
 * server (a separate process) share the clone without talking to each other.
 *
 *   "remote": { "url": "https://github.com/o/p.git", "ref": "main", "path": "vscode" }
 *
 * `ref` defaults to the remote's default branch (HEAD); `path` is the
 * project's folder inside the repository, if it isn't the root.
 */
export interface Remote {
  url: string;
  ref?: string;
  path?: string;
}

export function cacheRoot(): string {
  if (process.env.SLIPSTREAM_CACHE_DIR) return process.env.SLIPSTREAM_CACHE_DIR;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'slipstream', 'remotes');
  return path.join(os.homedir(), '.cache', 'slipstream', 'remotes');
}

/** One clone per (url, path): the folder inside the repository is stored in the clone's config. */
export function cacheDirFor(remote: Remote): string {
  const key = crypto.createHash('sha1').update(`${remote.url}\0${normalizePrefix(remote.path)}`).digest('hex').slice(0, 12);
  const name = (remote.url.replace(/\.git\/?$/, '').split(/[/:\\]/).filter(Boolean).pop() ?? 'repo').replace(/[^\w.-]/g, '_');
  return path.join(cacheRoot(), `${name}-${key}`);
}

export function isCloned(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'HEAD'));
}

const inflight = new Map<string, Promise<string>>();

/** Clone the remote into the cache if it isn't there yet. Returns the clone's directory. */
export function ensureClone(remote: Remote): Promise<string> {
  const dir = cacheDirFor(remote);
  if (isCloned(dir)) return Promise.resolve(dir);
  const pending = inflight.get(dir);
  if (pending) return pending;
  const p = (async () => {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const tmp = `${dir}.partial-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    await run('git', ['clone', '--bare', '--quiet', remote.url, tmp], { maxBuffer: 16 * 1024 * 1024 });
    await run('git', ['-C', tmp, 'config', 'slipstream.prefix', normalizePrefix(remote.path)]);
    // Rename into place so a half-finished clone is never mistaken for a usable one.
    try {
      fs.renameSync(tmp, dir);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (!isCloned(dir)) throw e; // someone else (the MCP server?) finished first: fine
    }
    clearResolved();
    return dir;
  })().finally(() => inflight.delete(dir));
  inflight.set(dir, p);
  return p;
}

/** Bring the cached clone up to date with the remote (branches and tags). */
export async function fetchRemote(remote: Remote): Promise<string> {
  const dir = await ensureClone(remote);
  await run('git', ['-C', dir, 'fetch', '--quiet', '--prune', 'origin', '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], {
    maxBuffer: 16 * 1024 * 1024,
  });
  clearResolved();
  return dir;
}

const resolved = new Map<string, string | null>();

/**
 * The commit a ref points at in a clone, synchronously (link resolution is
 * synchronous). Cached until the next clone or fetch. Undefined if the clone
 * doesn't exist yet or the ref doesn't resolve.
 */
export function resolvedCommit(dir: string, ref: string): string | undefined {
  const key = `${dir}\0${ref}`;
  if (resolved.has(key)) return resolved.get(key) ?? undefined;
  let hash: string | null = null;
  if (isCloned(dir)) {
    try {
      hash = execFileSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() || null;
    } catch {
      hash = null;
    }
  }
  resolved.set(key, hash);
  return hash ?? undefined;
}

export function clearResolved() {
  resolved.clear();
}

/** 'vscode', '/vscode/', 'vscode\\' → 'vscode/'; '' or undefined → ''. */
export function normalizePrefix(p: string | undefined): string {
  const clean = (p ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return clean ? `${clean}/` : '';
}

export function parseRemote(raw: unknown): Remote | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== 'string' || !r.url) return undefined;
  return {
    url: r.url,
    ...(typeof r.ref === 'string' && r.ref ? { ref: r.ref } : {}),
    ...(typeof r.path === 'string' && r.path ? { path: r.path } : {}),
  };
}
