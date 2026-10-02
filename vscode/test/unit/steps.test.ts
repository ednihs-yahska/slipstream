import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { excludeFromGit } from '../../src/practice/git';
import { computeSteps, modifyStepFor, StepInput } from '../../src/steps/StepModel';
import { similarity } from '../../src/steps/scan';

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-steps-')));
});

function write(root: string, files: Record<string, string | Buffer>) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
function gitRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
}
const input = (practiceRoot: string, targetRoot: string, extra: Partial<StepInput> = {}): StepInput => ({
  practiceRoot,
  targetRoot,
  lenientWhitespace: true,
  ...extra,
});
const summary = (steps: Awaited<ReturnType<typeof computeSteps>>) =>
  steps.map((s) => `${s.kind} ${s.from ? `${s.from} → ` : ''}${s.path}${s.changes !== undefined ? ` (${s.changes})` : ''}`);

describe('practice folder inside a git project (the default)', () => {
  let proj: string;
  let practice: string;
  beforeEach(async () => {
    proj = path.join(tmp, 'proj');
    practice = path.join(proj, '.slipstream/practice');
    gitRepo(proj);
    write(proj, {
      '.gitignore': 'dist/\n',
      'src/keep.ts': 'same();\n',
      'src/edit.ts': 'a();\nb();\n',
      'src/gone.ts': 'old();\n',
    });
    git(proj, 'add', '.');
    git(proj, 'commit', '-qm', 'base');
    // Practice folder = the commit; then the "agent" changes the project.
    write(practice, {
      '.gitignore': 'dist/\n',
      'src/keep.ts': 'same();\n',
      'src/edit.ts': 'a();\nb();\n',
      'src/gone.ts': 'old();\n',
      'dist/out.js': 'built',
    });
    await excludeFromGit(proj, practice);
    write(proj, { 'src/edit.ts': 'a();\nB();\nc();\n', 'src/new.ts': 'one();\ntwo();\n', 'package-lock.json': '{}' });
    fs.rmSync(path.join(proj, 'src/gone.ts'));
  });

  it('lists what to create, modify, copy and delete', async () => {
    expect(summary(await computeSteps(input(practice, proj)))).toEqual([
      'modify src/edit.ts (1)',
      'create src/new.ts (2)',
      'copy package-lock.json',
      'delete src/gone.ts',
    ]);
  });

  it('a modify step disappears once the practice file matches (whitespace aside)', async () => {
    write(practice, { 'src/edit.ts': 'a();\n  B();\n\nc();\n' });
    expect(summary(await computeSteps(input(practice, proj)))).not.toContain('modify src/edit.ts (1)');
    expect(await modifyStepFor(input(practice, proj, { lenientWhitespace: false }), 'src/edit.ts')).toMatchObject({ kind: 'modify' });
  });

  it('uses unsaved editor text for practice files', async () => {
    const unsaved = new Map([['src/edit.ts', 'a();\nB();\nc();\n']]);
    expect(await modifyStepFor(input(practice, proj, { unsaved }), 'src/edit.ts')).toBeUndefined();
  });

  it('ignores practice files the project gitignores', async () => {
    const steps = await computeSteps(input(practice, proj));
    expect(steps.some((s) => s.path.startsWith('dist/'))).toBe(false);
  });
});

it('detects a move; on equal similarity, prefers the same file name', async () => {
  const proj = path.join(tmp, 'p');
  const practice = path.join(tmp, 'q');
  const body = 'export function util() {\n  return 1;\n}\nexport const x = 2;\n';
  write(proj, { 'lib/util.ts': body.replace('2', '3'), 'lib/other.ts': body.replace('2', '4') });
  write(practice, { 'utils.ts': 'unrelated\n', 'src/util.ts': body });
  expect(summary(await computeSteps(input(practice, proj)))).toEqual([
    'rename src/util.ts → lib/util.ts',
    'create lib/other.ts (4)',
    'delete utils.ts',
  ]);
});

it('works with a practice folder outside a non-git project', async () => {
  const proj = path.join(tmp, 'plain');
  const practice = path.join(tmp, 'elsewhere');
  write(proj, { 'a.txt': 'x\n', 'node_modules/dep/index.js': 'skip me' });
  write(practice, {});
  fs.mkdirSync(practice, { recursive: true });
  expect(summary(await computeSteps(input(practice, proj)))).toEqual(['create a.txt (1)']);
});

it('works the other way round: target is a shadow inside the practice folder', async () => {
  const proj = path.join(tmp, 'rev');
  write(proj, { 'a.ts': 'old\n', '.slipstream/shadow/a.ts': 'new\n', '.slipstream/shadow/b.ts': 'b\n' });
  expect(summary(await computeSteps(input(proj, path.join(proj, '.slipstream/shadow'))))).toEqual([
    'modify a.ts (1)',
    'create b.ts (1)',
  ]);
});

it('treats binary files as copy steps', async () => {
  const proj = path.join(tmp, 'bin');
  const practice = path.join(tmp, 'binp');
  write(proj, { 'logo.png': Buffer.from([0x89, 0x50, 0, 0, 1, 2]) });
  fs.mkdirSync(practice);
  expect(summary(await computeSteps(input(practice, proj)))).toEqual(['copy logo.png']);
});

describe('similarity', () => {
  it('scores line overlap', () => {
    expect(similarity('a\nb\nc\n', 'a\nb\nc\n')).toBe(1);
    expect(similarity('a\nb\n', 'c\nd\n')).toBe(0);
    expect(similarity('a\nb\nc\nd\n', 'a\nb\nx\ny\n')).toBe(0.5);
  });
});
