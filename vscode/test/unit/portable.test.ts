import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { changedBetween, initPracticeRepo, originOf } from '../../src/practice/git';
import { createProgressFile, readProgress, writeProgress } from '../../src/steps/progress';
import { computeSteps } from '../../src/steps/StepModel';
import { clearLinkCache, readLink, sameRemote, updateLink, writeLink, writeLocalOverride } from '../../src/target/links';
import { cacheDirFor, ensureClone, fetchRemote, isCloned } from '../../src/target/remotes';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-m6-')));
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim();

let work: string; // the developer's checkout of the project repository
let remote: string; // the "remote": a bare repository, addressed by path like any git URL
let app: string; // the project, in a subfolder of the repository
const first = { hash: '' };

beforeAll(() => {
  process.env.SLIPSTREAM_CACHE_DIR = tmp();
  for (const k of ['AUTHOR', 'COMMITTER']) {
    process.env[`GIT_${k}_NAME`] = 'Test';
    process.env[`GIT_${k}_EMAIL`] = 't@t';
  }
  const root = tmp();
  remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  work = path.join(root, 'work');
  execFileSync('git', ['clone', '-q', remote, work], { stdio: 'pipe' });
  app = path.join(work, 'app');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.writeFileSync(path.join(app, 'src/a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(work, 'outside.txt'), 'not part of the project\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'first');
  git(work, 'push', '-q', 'origin', 'main');
  first.hash = git(work, 'rev-parse', 'HEAD');
});

describe('the project as a remote', () => {
  it("records the project's origin, branch and folder", async () => {
    expect(await originOf(app)).toEqual({ url: remote, ref: 'main', path: 'app' });
  });

  it('clones into the cache once, and reads the project folder at the branch tip', async () => {
    const r = { url: remote, ref: 'main', path: 'app' };
    const dir = await ensureClone(r);
    expect(dir).toBe(cacheDirFor(r));
    expect(isCloned(dir)).toBe(true);
    expect(await ensureClone(r)).toBe(dir); // no second clone

    const practice = path.join(tmp(), 'practice');
    fs.mkdirSync(practice);
    writeLink(practice, '/nowhere/on/this/machine', { remote: r });
    const link = readLink(practice)!;
    expect(link).toMatchObject({ source: 'remote', targetRoot: dir, ref: first.hash, refLabel: 'main' });

    const steps = await computeSteps({ practiceRoot: practice, targetRoot: link.targetRoot, targetRef: link.ref, lenientWhitespace: true });
    expect(steps.map((s) => `${s.kind} ${s.path}`)).toEqual(['create src/a.ts']); // not outside.txt
  });

  it('follows the branch after a fetch, staying one session (same label)', async () => {
    const r = { url: remote, ref: 'main', path: 'app' };
    const practice = path.join(tmp(), 'practice');
    fs.mkdirSync(practice);
    writeLink(practice, '/nowhere', { remote: r });
    const before = readLink(practice)!;

    fs.writeFileSync(path.join(app, 'src/b.ts'), 'export const b = 2;\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', 'second');
    git(work, 'push', '-q', 'origin', 'main');
    const second = git(work, 'rev-parse', 'HEAD');

    expect(readLink(practice)!.ref).toBe(before.ref); // nothing fetched yet
    await fetchRemote(r);
    clearLinkCache();
    const after = readLink(practice)!;
    expect(after.ref).toBe(second);
    expect(after.refLabel).toBe(before.refLabel);
    expect(await changedBetween(after.targetRoot, first.hash, 'main')).toBe(true);
  });

  it('keeps a separate clone per project folder', () => {
    expect(cacheDirFor({ url: remote, path: 'app' })).not.toBe(cacheDirFor({ url: remote, path: 'other' }));
  });

  it('reads a pinned commit when link.json has one', () => {
    const practice = path.join(tmp(), 'practice');
    fs.mkdirSync(practice);
    writeLink(practice, '/nowhere', { ref: first.hash, remote: { url: remote, path: 'app' } });
    expect(readLink(practice)).toMatchObject({ source: 'remote', ref: first.hash, pinned: true });
  });
});

describe('resolution order', () => {
  it('override, then a committed path that is a checkout of the remote, then the remote', () => {
    const practice = path.join(app, '.slipstream/practice');
    fs.mkdirSync(practice, { recursive: true });
    writeLink(practice, app, { remote: { url: remote, path: 'app' } });
    expect(JSON.parse(fs.readFileSync(path.join(practice, '.slipstream/link.json'), 'utf8')).target).toBe('../..');
    expect(readLink(practice)).toMatchObject({ source: 'path', targetRoot: app });

    const elsewhere = tmp();
    writeLocalOverride(practice, elsewhere);
    expect(readLink(practice)).toMatchObject({ source: 'override', targetRoot: elsewhere });
  });

  it('does not trust a relative path that exists but is some other folder', () => {
    // A practice repo cloned elsewhere: "../.." from its new home is an unrelated directory.
    const home = tmp();
    const practice = path.join(home, 'a', 'b');
    fs.mkdirSync(practice, { recursive: true });
    fs.mkdirSync(path.join(practice, '.slipstream'));
    fs.writeFileSync(path.join(practice, '.slipstream/link.json'), JSON.stringify({ target: '../..', remote: { url: remote, path: 'app' } }));
    expect(fs.existsSync(path.join(practice, '../..'))).toBe(true);
    expect(readLink(practice)!.source).toBe('remote');
  });

  it('updates a link in place, keeping a relative target and the remote', () => {
    const practice = path.join(app, '.slipstream/practice2');
    fs.mkdirSync(practice, { recursive: true });
    writeLink(practice, app, { remote: { url: remote, path: 'app' }, ref: 'abc' });
    updateLink(practice, { ref: undefined });
    expect(JSON.parse(fs.readFileSync(path.join(practice, '.slipstream/link.json'), 'utf8'))).toEqual({
      target: '../..',
      remote: { url: remote, path: 'app' },
    });
  });

  it('treats spellings of one remote as the same', () => {
    expect(sameRemote('https://github.com/O/P.git', 'https://github.com/o/p/')).toBe(true);
    expect(sameRemote('git@github.com:o/p.git', 'git@github.com:o/p')).toBe(true);
    expect(sameRemote('https://github.com/o/p', 'https://github.com/o/q')).toBe(false);
  });
});

describe('a practice folder as its own repository', () => {
  it('git init, ignore the per-machine override, first commit', async () => {
    const practice = tmp();
    fs.writeFileSync(path.join(practice, 'x.ts'), 'x');
    expect(await initPracticeRepo(practice, 'Start practising')).toEqual({ committed: true });
    expect(fs.readFileSync(path.join(practice, '.slipstream/.gitignore'), 'utf8')).toContain('link.local.json');
    expect(fs.existsSync(path.join(practice, '.gitignore'))).toBe(false); // it would be a practice file, and a step
    expect(git(practice, 'log', '--format=%s')).toBe('Start practising');
    fs.mkdirSync(path.join(practice, '.slipstream'), { recursive: true });
    fs.writeFileSync(path.join(practice, '.slipstream/link.local.json'), '{}');
    expect(git(practice, 'status', '--porcelain')).toBe('');
  });

  it('cloned onto another machine, it finds the project through the remote', async () => {
    const practice = path.join(tmp(), 'mine');
    fs.mkdirSync(practice);
    writeLink(practice, app, { remote: { url: remote, ref: 'main', path: 'app' } });
    await initPracticeRepo(practice, 'Start');
    const clone = path.join(tmp(), 'cloned');
    execFileSync('git', ['clone', '-q', practice, clone], { stdio: 'pipe' });
    clearLinkCache();
    // Absolute target: also present here (same disk), and a checkout of the remote: path wins…
    expect(readLink(clone)!.source).toBe('path');
    // …until it's gone, as it would be on another machine.
    const json = JSON.parse(fs.readFileSync(path.join(clone, '.slipstream/link.json'), 'utf8'));
    json.target = '/Users/someone-else/code/project/app';
    fs.writeFileSync(path.join(clone, '.slipstream/link.json'), JSON.stringify(json));
    clearLinkCache();
    expect(readLink(clone)!.source).toBe('remote');
  });
});

describe('progress in the practice folder', () => {
  it('is opt-in, keyed by what is being typed', () => {
    const practice = tmp();
    const p = { seen: { 'file:a.ts': { kind: 'create' as const, path: 'a.ts' } }, stats: { typed: 5, accepted: 2, startedAt: 1 } };
    expect(writeProgress(practice, 'main', p)).toBe(false); // not opted in
    expect(readProgress(practice, 'main')).toBeUndefined();
    createProgressFile(practice, 'main', p);
    expect(readProgress(practice, 'main')).toEqual(p);
    expect(writeProgress(practice, 'abc123', p)).toBe(true);
    expect(readProgress(practice, 'abc123')).toEqual(p);
    expect(readProgress(practice, 'main')).toEqual(p);
  });
});
