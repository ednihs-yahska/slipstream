import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractAt, neighbours, recentCommits, resettableEntries, saveIfRepo } from '../../src/practice/git';
import { ensureClone } from '../../src/target/remotes';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-m8-')));
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString().trim();
let work: string;
let bare: string;
const hashes: string[] = [];

beforeAll(() => {
  process.env.SLIPSTREAM_CACHE_DIR = tmp();
  for (const k of ['AUTHOR', 'COMMITTER']) {
    process.env[`GIT_${k}_NAME`] = 'T';
    process.env[`GIT_${k}_EMAIL`] = 't@t';
  }
  const root = tmp();
  bare = path.join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  work = path.join(root, 'work');
  execFileSync('git', ['clone', '-q', bare, work], { stdio: 'pipe' });
  for (const [file, text, msg] of [
    ['app/a.ts', 'a1\n', 'one'],
    ['other.txt', 'x\n', 'outside app'],
    ['app/a.ts', 'a1\na2\n', 'two'],
  ]) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), text);
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', msg);
    hashes.push(git(work, 'rev-parse', 'HEAD'));
  }
  git(work, 'push', '-q', 'origin', 'main');
});

describe('history of a folder', () => {
  it('lists commits touching it, from a working tree', async () => {
    expect((await recentCommits(path.join(work, 'app'))).map((c) => c.subject)).toEqual(['two', 'one']);
  });

  it('and from a bare clone of a remote, by the project folder recorded in the clone', async () => {
    const dir = await ensureClone({ url: bare, path: 'app' });
    expect((await recentCommits(dir, 200, 'main')).map((c) => c.subject)).toEqual(['two', 'one']);
  });

  it('extracts the folder at a commit, from either', async () => {
    const dir = await ensureClone({ url: bare, path: 'app' });
    const dest = tmp();
    await extractAt(dir, hashes[0], dest);
    // Git on Windows may convert line endings (core.autocrlf); Slipstream normalizes them anyway.
    expect(fs.readFileSync(path.join(dest, 'a.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe('a1\n');
    expect(fs.existsSync(path.join(dest, 'other.txt'))).toBe(false);
  });
});

describe('moving a practice folder', () => {
  it('finds older and newer neighbours, newest first', () => {
    const h = [{ hash: 'c3' }, { hash: 'c2' }, { hash: 'c1' }];
    expect(neighbours(h, 'c2')).toEqual({ older: { hash: 'c1' }, newer: { hash: 'c3' } });
    expect(neighbours(h, 'c3')).toEqual({ older: { hash: 'c2' }, newer: undefined });
    expect(neighbours(h, undefined)).toEqual({ older: { hash: 'c3' } }); // from "latest"
  });

  it('commits typing in a practice repo before a reset, and replaces everything but .git and .slipstream', async () => {
    const practice = tmp();
    git(practice, 'init', '-q');
    fs.mkdirSync(path.join(practice, '.slipstream'));
    fs.writeFileSync(path.join(practice, '.slipstream/link.json'), '{}');
    fs.writeFileSync(path.join(practice, 'mine.ts'), 'typed\n');
    expect(await saveIfRepo(practice, 'save')).toBe('committed');
    expect(await saveIfRepo(practice, 'save')).toBe('clean');
    expect(resettableEntries(practice).map((p) => path.basename(p))).toEqual(['mine.ts']);
    expect(await saveIfRepo(tmp(), 'save')).toBe('not-a-repo');
  });
});
