import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { isInside, META_DIR } from '../target/links';

const run = promisify(execFile);

export async function gitInfo(dir: string): Promise<{ prefix: string; dirty: boolean } | undefined> {
  try {
    const { stdout: prefix } = await run('git', ['-C', dir, 'rev-parse', '--show-prefix']);
    const { stdout: status } = await run('git', ['-C', dir, 'status', '--porcelain']);
    return { prefix: prefix.trim(), dirty: status.trim().length > 0 };
  } catch {
    return undefined;
  }
}

/**
 * `git archive <treeish> | tar -x -C <dest>`, run from the repo root: inside a
 * subfolder, git archive silently restricts itself to that subfolder, which
 * combined with a `rev:sub/` treeish yields an empty archive.
 */
export async function gitArchive(repoDir: string, treeish: string, dest: string): Promise<void> {
  const { stdout: top } = await run('git', ['-C', repoDir, 'rev-parse', '--show-toplevel']);
  return new Promise((resolve, reject) => {
    const archive = spawn('git', ['-C', top.trim(), 'archive', '--format=tar', treeish]);
    const tar = spawn('tar', ['-x', '-C', dest]);
    let err = '';
    archive.stderr.on('data', (d) => (err += d));
    tar.stderr.on('data', (d) => (err += d));
    // A broken pipe shows up in the exit codes below; unhandled, it would throw.
    tar.stdin.on('error', () => undefined);
    archive.on('error', reject);
    tar.on('error', reject);
    archive.stdout.pipe(tar.stdin);
    archive.on('close', (code) => code !== 0 && reject(new Error(err.trim() || `git archive exited ${code}`)));
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `tar exited ${code}`))));
  });
}

/**
 * Keep a practice folder inside the project out of git and out of the agent's
 * searches. Uses `.git/info/exclude`, which is local and never committed.
 * Anything under the project's `.slipstream/` (practice and replay folders,
 * the agent's plan.md, link files) is excluded as a whole.
 */
export async function excludeFromGit(targetRoot: string, practiceRoot: string): Promise<boolean> {
  try {
    const { stdout: top } = await run('git', ['-C', targetRoot, 'rev-parse', '--show-toplevel']);
    const repoRoot = canonical(top.trim());
    const practice = realpathLoose(practiceRoot);
    if (!isInside(practice, repoRoot)) return false;
    const { stdout: excludePath } = await run('git', ['-C', repoRoot, 'rev-parse', '--git-path', 'info/exclude']);
    const file = path.resolve(repoRoot, excludePath.trim());

    // `<project>/.slipstream/…` → exclude `<project>/.slipstream/` itself.
    const project = realpathLoose(targetRoot);
    const meta = path.join(project, META_DIR);
    const dir = isInside(practice, meta) ? meta : practice;
    const pattern = '/' + path.relative(repoRoot, dir).split(path.sep).join('/') + '/';

    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!current.split(/\r?\n/).includes(pattern)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}# Slipstream practice folders and agent plan\n${pattern}\n`);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The OS's canonical path. On Windows the JS `realpathSync` keeps 8.3 short names
 * (`C:\Users\RUNNER~1\…`) while git reports long ones, so paths that are the same
 * folder compared as different; `.native` asks the OS and returns the long form.
 */
function canonical(p: string): string {
  return fs.realpathSync.native(p);
}

/** realpath of `p`, or of its nearest existing ancestor joined with the rest (for paths not created yet). */
function realpathLoose(p: string): string {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) return canonical(abs);
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(realpathLoose(parent), path.basename(abs));
}


export interface Commit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  when: string;
}

/** Recent commits touching `dir` (newest first), for pickers. */
export async function recentCommits(dir: string, max = 200): Promise<Commit[]> {
  const { stdout } = await run('git', ['-C', dir, 'log', `-n${max}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar', '--', '.'], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, short, subject, author, when] = line.split('\x1f');
      return { hash, short, subject, author, when };
    });
}

/** Full hash of a revision. */
export async function resolveRev(dir: string, rev: string): Promise<string> {
  const { stdout } = await run('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return stdout.trim();
}

/** The first parent of a commit, or undefined for a root commit. */
export async function parentOf(dir: string, rev: string): Promise<string | undefined> {
  try {
    return await resolveRev(dir, `${rev}^`);
  } catch {
    return undefined;
  }
}

/**
 * Commits from `from` (inclusive) to `to` along the first-parent chain, oldest
 * first, keeping only those that touch `dir`. First-parent skips the inside of
 * merged branches, which is the history as the main line experienced it.
 */
export async function commitsInRange(dir: string, from: string, to: string): Promise<string[]> {
  const fromHash = await resolveRev(dir, from);
  const { stdout } = await run('git', ['-C', dir, 'rev-list', '--reverse', '--first-parent', to, '--', '.'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const chain = stdout.split('\n').filter(Boolean);
  const start = chain.indexOf(fromHash);
  if (start < 0) throw new Error(`${from} is not on the first-parent history of ${to} (or doesn't touch this folder).`);
  return chain.slice(start);
}

/** One-line subject of a commit. */
export async function subjectOf(dir: string, rev: string): Promise<string> {
  const { stdout } = await run('git', ['-C', dir, 'log', '-1', '--format=%s', rev]);
  return stdout.trim();
}

/** Repo toplevel and the folder's prefix inside it ('' or 'sub/dir/'). */
export async function repoPaths(dir: string): Promise<{ top: string; prefix: string }> {
  try {
    const { stdout: top } = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
    const { stdout: prefix } = await run('git', ['-C', dir, 'rev-parse', '--show-prefix']);
    return { top: top.trim(), prefix: prefix.trim() };
  } catch (e) {
    // A bare clone (a remote target's cache) has no working tree: the project's folder
    // inside the repository is recorded in the clone's own config.
    const { stdout: bare } = await run('git', ['-C', dir, 'rev-parse', '--is-bare-repository']).catch(() => ({ stdout: '' }));
    if (bare.trim() !== 'true') throw e;
    const { stdout: prefix } = await run('git', ['-C', dir, 'config', '--get', 'slipstream.prefix']).catch(() => ({ stdout: '' }));
    return { top: dir, prefix: prefix.trim() };
  }
}

/** Whether `dir`'s folder differs between two revisions (works in bare clones too). */
export async function changedBetween(dir: string, from: string, to: string): Promise<boolean> {
  const { top, prefix } = await repoPaths(dir);
  try {
    await run('git', ['-C', top, 'diff', '--quiet', from, to, '--', prefix || '.']);
    return false;
  } catch (e) {
    if ((e as { code?: number }).code === 1) return true;
    throw e;
  }
}

/** The project's `origin` as a remote target: URL, current branch, and its folder in the repository. */
export async function originOf(dir: string): Promise<{ url: string; ref?: string; path?: string } | undefined> {
  try {
    const { stdout: url } = await run('git', ['-C', dir, 'remote', 'get-url', 'origin']);
    const { prefix } = await repoPaths(dir);
    const { stdout: branch } = await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: '' }));
    const ref = branch.trim() && branch.trim() !== 'HEAD' ? branch.trim() : undefined;
    const p = prefix.replace(/\/$/, '');
    return { url: url.trim(), ...(ref ? { ref } : {}), ...(p ? { path: p } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * Make a practice folder its own git repository: `git init`, a .gitignore for
 * the per-machine files, and a first commit (skipped, not failed, if git has
 * no user identity configured). Returns whether it committed.
 */
export async function initPracticeRepo(dir: string, message: string): Promise<{ committed: boolean }> {
  await run('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  const ignore = path.join(dir, '.gitignore');
  const lines = ['.slipstream/link.local.json'];
  const current = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  const missing = lines.filter((l) => !current.split(/\r?\n/).includes(l));
  if (missing.length) {
    fs.appendFileSync(ignore, `${current && !current.endsWith('\n') ? '\n' : ''}# Slipstream: per-machine\n${missing.join('\n')}\n`);
  }
  await run('git', ['-C', dir, 'add', '-A']);
  try {
    await run('git', ['-C', dir, 'commit', '-q', '-m', message]);
    return { committed: true };
  } catch {
    return { committed: false };
  }
}

/**
 * Whether `dir` as it is now (committed after `ref`, uncommitted, or new
 * untracked files) differs from `dir` at `ref`.
 */
export async function changedSince(dir: string, ref: string): Promise<boolean> {
  try {
    await run('git', ['-C', dir, 'diff', '--quiet', ref, '--', '.']);
  } catch (e) {
    if ((e as { code?: number }).code === 1) return true;
    throw e;
  }
  const { stdout } = await run('git', ['-C', dir, 'ls-files', '--others', '--exclude-standard', '--', '.']);
  return stdout.trim().length > 0;
}

/**
 * Keep files out of git locally (`.git/info/exclude`, never committed), unless
 * git already ignores them. `rels` are relative to `dir`. Returns the ones added.
 */
export async function excludeFiles(dir: string, rels: string[]): Promise<string[]> {
  const added: string[] = [];
  try {
    const { stdout: top } = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
    const repoRoot = canonical(top.trim());
    const { stdout: excludePath } = await run('git', ['-C', repoRoot, 'rev-parse', '--git-path', 'info/exclude']);
    const file = path.resolve(repoRoot, excludePath.trim());
    for (const rel of rels) {
      const abs = path.join(canonical(dir), rel);
      const fromRoot = path.relative(repoRoot, abs).split(path.sep).join('/');
      try {
        await run('git', ['-C', repoRoot, 'check-ignore', '-q', '--no-index', fromRoot]);
        continue; // already ignored
      } catch {
        // not ignored yet
      }
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}# Slipstream (personal)\n/${fromRoot}\n`);
      added.push(rel);
    }
  } catch {
    // not a git repo
  }
  return added;
}

/** Git's empty tree: what a root commit is diffed against. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Lines a commit added inside `dir`'s folder (works in bare clones too), for
 * estimating how long typing it will take. Cached: commits don't change.
 */
const addedCache = new Map<string, string[]>();
export async function addedLines(dir: string, commit: string): Promise<string[]> {
  const key = `${dir}\0${commit}`;
  const hit = addedCache.get(key);
  if (hit) return hit;
  const { top, prefix } = await repoPaths(dir);
  const parent = await run('git', ['-C', top, 'rev-parse', '--verify', '--quiet', `${commit}^`]).then(
    (r) => r.stdout.trim(),
    () => EMPTY_TREE,
  );
  const { stdout } = await run('git', ['-C', top, 'diff', '--unified=0', '--no-color', '--no-ext-diff', parent, commit, '--', prefix || '.'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const lines = stdout
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
  addedCache.set(key, lines);
  return lines;
}
