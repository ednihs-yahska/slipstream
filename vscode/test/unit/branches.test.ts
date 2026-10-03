import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { branches, recentCommits } from '../../src/practice/git';
import { clearLinkCache, readLink, writeLink } from '../../src/target/links';
import { ensureClone } from '../../src/target/remotes';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-branch-')));
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString().trim();
let work: string;
let bare: string;
let featureTip: string;

function commit(file: string, text: string, msg: string) {
  fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
  fs.writeFileSync(path.join(work, file), text);
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', msg);
}

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
  commit('a.ts', 'a1\n', 'on main');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'feature');
  commit('a.ts', 'a1\nfeature\n', 'on feature');
  featureTip = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '-q', 'origin', 'feature');
  // A branch that exists only on the remote: the working tree knows it as origin/elsewhere.
  git(work, 'checkout', '-q', '-b', 'elsewhere', 'main');
  commit('b.ts', 'b\n', 'elsewhere');
  git(work, 'push', '-q', 'origin', 'elsewhere');
  git(work, 'checkout', '-q', 'main');
  git(work, 'branch', '-q', '-D', 'elsewhere');
});

describe('branches', () => {
  it('in a working tree: the checked-out branch first, then local and remote-only branches', async () => {
    const list = await branches(work);
    expect(list[0]).toEqual({ name: 'main', current: true });
    expect(list.map((b) => b.name).sort()).toEqual(['feature', 'main', 'origin/elsewhere']);
  });

  it("in a remote's cached clone: the default branch first, and every branch", async () => {
    const dir = await ensureClone({ url: bare });
    const list = await branches(dir);
    expect(list[0]).toEqual({ name: 'main', current: true });
    expect(list.map((b) => b.name).sort()).toEqual(['elsewhere', 'feature', 'main']);
    expect((await recentCommits(dir, 200, 'feature')).map((c) => c.subject)).toEqual(['on feature', 'on main']);
  });
});

describe('a link to a branch', () => {
  it('of a local project: the working tree while that branch is checked out, else its tip', () => {
    const practice = tmp();
    writeLink(practice, work, { branch: 'main' });
    clearLinkCache();
    const checkedOut = readLink(practice)!;
    expect(checkedOut).toMatchObject({ targetRoot: work, branch: 'main' });
    expect(checkedOut.ref).toBeUndefined();

    writeLink(practice, work, { branch: 'feature' });
    clearLinkCache();
    const link = readLink(practice)!;
    expect(link).toMatchObject({ targetRoot: work, branch: 'feature', ref: featureTip, refLabel: 'feature' });
    expect(link.pinned).toBeUndefined();
  });

  it('of a remote: the remote ref is the branch', async () => {
    const practice = tmp();
    await ensureClone({ url: bare });
    fs.mkdirSync(path.join(practice, '.slipstream'));
    fs.writeFileSync(path.join(practice, '.slipstream', 'link.json'), JSON.stringify({ remote: { url: bare, ref: 'feature' } }));
    clearLinkCache();
    expect(readLink(practice)).toMatchObject({ source: 'remote', branch: 'feature', ref: featureTip, refLabel: 'feature' });
  });
});
