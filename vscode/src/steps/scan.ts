import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { repoPaths } from '../practice/git';
import { isInside, META_DIR } from '../target/links';

const run = promisify(execFile);

/** Never part of a practice session, wherever they appear. */
const SKIP_DIRS = new Set(['.git', 'node_modules', META_DIR]);

/** Relative paths always use '/', on every platform. */
export const toKey = (rel: string) => rel.split(path.sep).join('/');

/**
 * Files in the project (target). In a git repo: tracked plus untracked-but-not-
 * ignored files, so the agent's new files count before they're committed and
 * .gitignore is respected. Otherwise (or if git sees nothing, e.g. a shadow dir
 * git ignores): a plain walk.
 */
export async function listTargetFiles(targetRoot: string, skipRoots: string[] = []): Promise<string[]> {
  try {
    const { stdout } = await run('git', ['-C', targetRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const files = [...new Set(stdout.split('\0').filter(Boolean))]
      .filter((rel) => !rel.split('/').some((part) => SKIP_DIRS.has(part)))
      .filter((rel) => !skipRoots.some((r) => isInside(path.join(targetRoot, rel), r)))
      // --cached lists tracked files even if they were deleted from disk.
      .filter((rel) => fs.existsSync(path.join(targetRoot, rel)));
    if (files.length > 0) return files.sort();
  } catch {
    // not a git repo
  }
  return walk(targetRoot, skipRoots);
}

/** Files in the practice folder, minus anything the project's .gitignore would ignore (build output, etc.). */
export async function listPracticeFiles(practiceRoot: string, targetRoot: string, skipRoots: string[] = []): Promise<string[]> {
  const files = await walk(practiceRoot, skipRoots);
  const ignored = await gitIgnored(targetRoot, files);
  return files.filter((f) => !ignored.has(f));
}

async function walk(root: string, skipRoots: string[]): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !skipRoots.some((r) => isInside(abs, r))) await visit(abs);
      } else if (e.isFile()) {
        out.push(toKey(path.relative(root, abs)));
      }
    }
  };
  await visit(root);
  return out.sort();
}

/** Which of `rels` the git repo at `repoDir` would ignore (empty if not a repo). */
function gitIgnored(repoDir: string, rels: string[]): Promise<Set<string>> {
  return new Promise((resolve) => {
    if (rels.length === 0) return resolve(new Set());
    const p = spawn('git', ['-C', repoDir, 'check-ignore', '--no-index', '--stdin', '-z']);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(new Set()));
    // Exit 1 just means "nothing ignored"; 128 means not a repo. Outside a repo git exits
    // without reading stdin, so writing the list can hit a closed pipe (EPIPE): that is
    // the same answer, not an error, and unhandled it would crash the extension host.
    p.stdin.on('error', () => undefined);
    p.on('close', () => resolve(new Set(out.split('\0').filter(Boolean))));
    p.stdin.end(rels.join('\0') + '\0');
  });
}

export interface FileContent {
  text?: string;
  binary: boolean;
  size: number;
}

const contentCache = new Map<string, { mtimeMs: number; size: number; content: FileContent }>();

/** Read a file, cached by mtime/size. Undefined if it doesn't exist. */
export async function readContent(abs: string): Promise<FileContent | undefined> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(abs);
  } catch {
    return undefined;
  }
  const cached = contentCache.get(abs);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.content;
  const buf = await fs.promises.readFile(abs);
  const binary = buf.subarray(0, 8000).includes(0);
  const content: FileContent = { binary, size: stat.size, text: binary ? undefined : buf.toString('utf8') };
  contentCache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, content });
  return content;
}

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
  'Package.resolved',
  'pubspec.lock',
  'mix.lock',
]);

/** Files nobody should type by hand: copy them instead. */
export function shouldCopy(rel: string, content: FileContent): boolean {
  return content.binary || content.size > 512 * 1024 || LOCKFILES.has(path.posix.basename(rel));
}

/** How alike two texts are, 0..1 (Dice coefficient over non-blank lines). */
export function similarity(a: string, b: string): number {
  const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const la = lines(a);
  const lb = lines(b);
  if (la.length + lb.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const l of la) counts.set(l, (counts.get(l) ?? 0) + 1);
  let common = 0;
  for (const l of lb) {
    const n = counts.get(l) ?? 0;
    if (n > 0) {
      common++;
      counts.set(l, n - 1);
    }
  }
  return (2 * common) / (la.length + lb.length);
}

/** Files of `targetRoot` as of commit `ref` (relative to targetRoot). */
export async function listFilesAtRef(targetRoot: string, ref: string): Promise<string[]> {
  const { top, prefix } = await repoPaths(targetRoot);
  const { stdout } = await run('git', ['-C', top, 'ls-tree', '-r', '-z', '--name-only', `${ref}:${prefix}`], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .split('\0')
    .filter(Boolean)
    .filter((rel) => !rel.split('/').some((part) => SKIP_DIRS.has(part)))
    .sort();
}

const blobCache = new Map<string, Buffer | null>();

/** Raw bytes of a file of `targetRoot` as of commit `ref`; undefined if it didn't exist. Cached: commits don't change. */
export async function readBlobAtRef(targetRoot: string, ref: string, rel: string): Promise<Buffer | undefined> {
  const key = `${targetRoot}\0${ref}\0${rel}`;
  if (blobCache.has(key)) return blobCache.get(key) ?? undefined;
  let buf: Buffer | null = null;
  try {
    const { top, prefix } = await repoPaths(targetRoot);
    const { stdout } = await run('git', ['-C', top, 'cat-file', 'blob', `${ref}:${prefix}${rel}`], {
      encoding: 'buffer',
      maxBuffer: 256 * 1024 * 1024,
    });
    buf = stdout as unknown as Buffer;
  } catch {
    buf = null;
  }
  blobCache.set(key, buf);
  return buf ?? undefined;
}

/** A file of `targetRoot` as of commit `ref`; undefined if it didn't exist. */
export async function readContentAtRef(targetRoot: string, ref: string, rel: string): Promise<FileContent | undefined> {
  const buf = await readBlobAtRef(targetRoot, ref, rel);
  if (!buf) return undefined;
  const binary = buf.subarray(0, 8000).includes(0);
  return { binary, size: buf.length, text: binary ? undefined : buf.toString('utf8') };
}
