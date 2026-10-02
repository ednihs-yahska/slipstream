import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { changedSince, commitsInRange, gitArchive, parentOf, recentCommits, subjectOf } from '../../src/practice/git';
import { listFilesAtRef, readContentAtRef } from '../../src/steps/scan';
import { computeSteps } from '../../src/steps/StepModel';
import { readLink, writeLink } from '../../src/target/links';

let repo: string;
let app: string; // a project in a subfolder of the repo
const hashes: string[] = [];
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString().trim();
function commit(files: Record<string, string | null>, msg: string) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    if (text === null) fs.rmSync(abs);
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
  }
  git('add', '-A');
  git('commit', '-qm', msg);
  hashes.push(git('rev-parse', 'HEAD'));
}

beforeAll(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-replay-')));
  app = path.join(repo, 'app');
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  commit({ 'app/a.ts': 'a1\n', 'other/x.ts': 'x\n' }, 'first');
  commit({ 'app/a.ts': 'a1\na2\n', 'app/b.ts': 'b\n' }, 'add b');
  commit({ 'other/x.ts': 'x2\n' }, 'outside app');
  commit({ 'app/b.ts': null, 'app/c.ts': 'c\n' }, 'swap b for c');
  // Uncommitted change in the working tree must not leak into replays.
  fs.writeFileSync(path.join(app, 'a.ts'), 'dirty\n');
});

describe('reading a commit', () => {
  it('lists a subfolder as of a commit', async () => {
    expect(await listFilesAtRef(app, hashes[1])).toEqual(['a.ts', 'b.ts']);
    expect(await listFilesAtRef(app, hashes[3])).toEqual(['a.ts', 'c.ts']);
  });

  it('reads file content as of a commit, ignoring the working tree', async () => {
    expect((await readContentAtRef(app, hashes[1], 'a.ts'))?.text).toBe('a1\na2\n');
    expect(await readContentAtRef(app, hashes[0], 'b.ts')).toBeUndefined();
  });
});

describe('history', () => {
  it('lists recent commits touching the folder', async () => {
    expect((await recentCommits(app)).map((c) => c.subject)).toEqual(['swap b for c', 'add b', 'first']);
  });

  it('gives the commits of a range touching the folder, oldest first', async () => {
    expect(await commitsInRange(app, hashes[1], 'HEAD')).toEqual([hashes[1], hashes[3]]);
  });

  it('rejects a start that is not in the history', async () => {
    await expect(commitsInRange(app, 'nope', 'HEAD')).rejects.toThrow();
  });

  it('knows parents and subjects', async () => {
    expect(await parentOf(app, hashes[1])).toBe(hashes[0]);
    expect(await parentOf(app, hashes[0])).toBeUndefined();
    expect(await subjectOf(app, hashes[3])).toBe('swap b for c');
  });
});

describe('replaying a commit', () => {
  it('seeds from the parent and lists exactly what the commit changed', async () => {
    const practice = path.join(repo, '.slipstream/replay');
    fs.mkdirSync(practice, { recursive: true });
    await gitArchive(app, `${hashes[2]}:app/`, practice);
    const steps = await computeSteps({ practiceRoot: practice, targetRoot: app, targetRef: hashes[3], lenientWhitespace: true });
    expect(steps.map((s) => `${s.kind} ${s.path}`)).toEqual(['create c.ts', 'delete b.ts']);
  });
});

it('links remember the commit and replay position', () => {
  const practice = path.join(repo, '.slipstream/linked');
  writeLink(practice, app, { ref: hashes[1], replay: { commits: [hashes[1], hashes[3]], index: 0 } });
  expect(readLink(practice)).toEqual({
    practiceRoot: practice,
    targetRoot: app,
    ref: hashes[1],
    refLabel: hashes[1],
    pinned: true,
    source: 'path',
    replay: { commits: [hashes[1], hashes[3]], index: 0 },
  });
});

describe('changedSince', () => {
  it('sees uncommitted changes', async () => {
    expect(await changedSince(app, hashes[3])).toBe(true); // a.ts is dirty
  });

  it('sees later commits, but only ones touching the folder', async () => {
    const clean = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-clean-')));
    const g = (...args: string[]) => execFileSync('git', ['-C', clean, ...args], { stdio: 'pipe' }).toString().trim();
    g('init', '-q');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    fs.mkdirSync(path.join(clean, 'app'));
    fs.writeFileSync(path.join(clean, 'app/a.ts'), '1\n');
    g('add', '-A');
    g('commit', '-qm', 'one');
    const first = g('rev-parse', 'HEAD');
    const appDir = path.join(clean, 'app');
    expect(await changedSince(appDir, first)).toBe(false);

    fs.writeFileSync(path.join(clean, 'elsewhere.txt'), 'x');
    g('add', '-A');
    g('commit', '-qm', 'outside app');
    expect(await changedSince(appDir, first)).toBe(false);

    fs.writeFileSync(path.join(appDir, 'new.ts'), 'untracked\n');
    expect(await changedSince(appDir, first)).toBe(true);
    fs.rmSync(path.join(appDir, 'new.ts'));

    fs.writeFileSync(path.join(appDir, 'a.ts'), '2\n');
    g('add', '-A');
    g('commit', '-qm', 'two');
    expect(await changedSince(appDir, first)).toBe(true);
  });
});
