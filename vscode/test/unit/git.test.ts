import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { excludeFiles, excludeFromGit, gitArchive, gitInfo } from '../../src/practice/git';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString();

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-git-')));
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'pkg/src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'pkg/src/a.ts'), 'committed\n');
  fs.writeFileSync(path.join(repo, 'root.txt'), 'root\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'pkg/src/a.ts'), 'agent changed this\n');
});

describe('gitInfo', () => {
  it('reports the subfolder prefix and uncommitted changes', async () => {
    expect(await gitInfo(path.join(repo, 'pkg'))).toEqual({ prefix: 'pkg/', dirty: true });
  });
  it('is undefined outside git', async () => {
    expect(await gitInfo(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-nogit-')))).toBeUndefined();
  });
});

describe('gitArchive', () => {
  it('extracts the committed version of a subfolder, without uncommitted changes', async () => {
    const dest = path.join(repo, '.slipstream/practice');
    fs.mkdirSync(dest, { recursive: true });
    await gitArchive(path.join(repo, 'pkg'), 'HEAD:pkg/', dest);
    expect(fs.readFileSync(path.join(dest, 'src/a.ts'), 'utf8')).toBe('committed\n');
    expect(fs.existsSync(path.join(dest, 'root.txt'))).toBe(false);
  });
  it('rejects a bad revision', async () => {
    await expect(gitArchive(repo, 'nope:', fs.mkdtempSync(path.join(os.tmpdir(), 'tc-')))).rejects.toThrow();
  });
});

describe('excludeFromGit', () => {
  it('hides a practice folder inside the repo, once', async () => {
    const practice = path.join(repo, '.slipstream/practice');
    fs.mkdirSync(practice, { recursive: true });
    fs.writeFileSync(path.join(practice, 'x.ts'), 'x');
    expect(await excludeFromGit(repo, practice)).toBe(true);
    expect(await excludeFromGit(repo, practice)).toBe(true);
    const exclude = fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8');
    // The whole .slipstream/ folder: practice, replay, and the agent's plan.md.
    expect(exclude.match(/^\/\.slipstream\/$/gm)).toHaveLength(1);
    fs.writeFileSync(path.join(repo, '.slipstream/plan.md'), '1. `a.ts`');
    expect(git('status', '--porcelain')).not.toContain('.slipstream');
  });
  it('does nothing for a folder outside the repo', async () => {
    expect(await excludeFromGit(repo, fs.mkdtempSync(path.join(os.tmpdir(), 'tc-out-')))).toBe(false);
  });
});

it('excludes a project in a subfolder of the repo by its own .slipstream/', async () => {
  expect(await excludeFromGit(path.join(repo, 'pkg'), path.join(repo, 'pkg/.slipstream/replay'))).toBe(true);
  expect(fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8')).toMatch(/^\/pkg\/\.slipstream\/$/m);
});

it('excludes a practice folder elsewhere in the repo by its own path', async () => {
  fs.mkdirSync(path.join(repo, 'practice-here'));
  expect(await excludeFromGit(path.join(repo, 'pkg'), path.join(repo, 'practice-here'))).toBe(true);
  expect(fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8')).toMatch(/^\/practice-here\/$/m);
});

describe('excludeFiles', () => {
  it('keeps personal files out of git locally, skipping ones already ignored', async () => {
    fs.writeFileSync(path.join(repo, '.gitignore'), 'already.md\n');
    fs.mkdirSync(path.join(repo, 'pkg/.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'pkg/CLAUDE.local.md'), 'x');
    fs.writeFileSync(path.join(repo, 'pkg/.claude/settings.local.json'), '{}');
    fs.writeFileSync(path.join(repo, 'pkg/already.md'), 'x');
    const added = await excludeFiles(path.join(repo, 'pkg'), ['CLAUDE.local.md', '.claude/settings.local.json', 'already.md']);
    // Already-ignored files are skipped (your global git excludes may already cover settings.local.json).
    expect(added).toContain('CLAUDE.local.md');
    expect(added).not.toContain('already.md');
    const status = git('status', '--porcelain', '--untracked-files=all');
    expect(status).not.toContain('CLAUDE.local.md');
    expect(status).not.toContain('settings.local.json');
    expect(await excludeFiles(path.join(repo, 'pkg'), ['CLAUDE.local.md'])).toEqual([]);
  });
});
