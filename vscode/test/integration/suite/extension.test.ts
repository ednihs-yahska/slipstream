import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SlipstreamApi } from '../../../src/extension';
import { createReplay, moreAfterReplay } from '../../../src/practice/replay';
import { hideFromSearch, SEARCH_PATTERN } from '../../../src/practice/search';
import { execFileSync } from 'child_process';

const api = () => vscode.extensions.getExtension<SlipstreamApi>('EdnihsYahska.slipstream')!.exports;
const changes = async (editor: vscode.TextEditor) => (await api().store.getHunks(editor.document)) ?? [];

/** The demo project: the agent's finished code (the target). */
const project = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
/** The demo's practice folder, linked to the project. */
const practice = (...p: string[]) => path.join(project(), '.slipstream/practice', ...p);

/** Open a file (creating it if needed) and optionally replace its text. */
async function open(file: string, content?: string): Promise<vscode.TextEditor> {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
  if (content !== undefined) {
    const doc = editor.document;
    await editor.edit((b) => b.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content));
  }
  return editor;
}

/** Text with line endings normalized: on Windows, new documents and git checkouts use CRLF. */
const lf = (text: string) => text.replace(/\r\n/g, '\n');
/** A document offset from line/column, so tests don't assume one-byte line endings. */
const at = (editor: vscode.TextEditor, line: number, character: number) =>
  editor.document.offsetAt(new vscode.Position(line, character));

function placeCursor(editor: vscode.TextEditor, offset: number) {
  const pos = editor.document.positionAt(offset);
  editor.selection = new vscode.Selection(pos, pos);
}

async function eventually(check: () => Promise<boolean>, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail('condition not met in time');
}

describe('Slipstream', () => {
  it('Tab types the next word and Shift+Tab the rest of the line into a new file', async () => {
    const editor = await open(practice('src/math.ts'), '');
    placeCursor(editor, 0);

    await vscode.commands.executeCommand('slipstream.acceptWord');
    assert.strictEqual(editor.document.getText(), 'export');

    await vscode.commands.executeCommand('slipstream.acceptWord');
    assert.strictEqual(editor.document.getText(), 'export function');

    await vscode.commands.executeCommand('slipstream.acceptLine');
    assert.strictEqual(
      editor.document.getText(),
      'export function clamp(value: number, min: number, max: number): number {',
    );

    // At end of line, Shift+Tab moves onto and completes the next line.
    await vscode.commands.executeCommand('slipstream.acceptLine');
    assert.strictEqual(editor.document.lineAt(1).text, '  if (min > max) {');
  });

  it('follows text you type yourself', async () => {
    const editor = await open(practice('src/math.ts'), 'export func');
    placeCursor(editor, editor.document.getText().length);
    await vscode.commands.executeCommand('slipstream.acceptWord');
    assert.strictEqual(editor.document.getText(), 'export function');
  });

  it('jumps to the next change in a modified file', async () => {
    const editor = await open(practice('src/greet.ts'));
    placeCursor(editor, editor.document.getText().length);
    // Wraps around to the first change: the new interface at the top of the file.
    await vscode.commands.executeCommand('slipstream.nextChange');
    assert.strictEqual(editor.selection.active.line, 0);
    assert.strictEqual(editor.selection.active.character, 0);
    await vscode.commands.executeCommand('slipstream.acceptLine');
    assert.strictEqual(editor.document.lineAt(0).text, 'export interface GreetOptions {');
    assert.strictEqual(editor.document.lineAt(1).text, 'export function greet(name: string): string {');
  });

  for (const file of ['src/math.ts', 'src/greet.ts']) {
    it(`accepting every change reproduces the target exactly (${file})`, async () => {
      // Lenient mode would (rightly) call it done before the last blank line.
      const cfg = vscode.workspace.getConfiguration('slipstream');
      await cfg.update('whitespace', 'exact', vscode.ConfigurationTarget.Global);
      try {
        const editor = await open(practice(file));
        const target = fs.readFileSync(path.join(project(), file), 'utf8');
        for (let i = 0; i < 200 && editor.document.getText() !== target; i++) {
          await vscode.commands.executeCommand('slipstream.nextChange');
          await vscode.commands.executeCommand('slipstream.deleteMarked');
          await vscode.commands.executeCommand('slipstream.acceptLine');
        }
        assert.strictEqual(editor.document.getText(), target);
      } finally {
        await cfg.update('whitespace', undefined, vscode.ConfigurationTarget.Global);
      }
    });
  }

  it('leaves the project files alone: no ghost, Tab indents as usual', async () => {
    const editor = await open(path.join(project(), 'src/math.ts'));
    const before = editor.document.getText();
    placeCursor(editor, 0);
    await vscode.commands.executeCommand('slipstream.acceptWord');
    assert.strictEqual(editor.document.getText().trimStart(), before.trimStart());
    assert.notStrictEqual(editor.document.getText(), before); // indented by the built-in tab
    await vscode.commands.executeCommand('undo');
  });

  it('picks up what the agent writes while you are practising', async () => {
    fs.writeFileSync(path.join(project(), 'src/live.ts'), 'first();\n');
    const editor = await open(practice('src/live.ts'), '');
    placeCursor(editor, 0);
    await vscode.commands.executeCommand('slipstream.acceptWord');
    assert.strictEqual(editor.document.getText(), 'first');

    fs.writeFileSync(path.join(project(), 'src/live.ts'), 'second();\n');
    await eventually(async () => {
      await editor.edit((b) => b.delete(new vscode.Range(0, 0, 0, editor.document.lineAt(0).text.length)));
      placeCursor(editor, 0);
      await vscode.commands.executeCommand('slipstream.acceptWord');
      return editor.document.getText() === 'second';
    });
  });

  it('works with a practice folder anywhere on disk', async () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-practice-')));
    fs.mkdirSync(path.join(elsewhere, '.slipstream'));
    fs.writeFileSync(path.join(elsewhere, '.slipstream/link.json'), JSON.stringify({ target: project() }));
    const editor = await open(path.join(elsewhere, 'src/math.ts'));
    placeCursor(editor, 0);
    await vscode.commands.executeCommand('slipstream.acceptLine');
    assert.strictEqual(editor.document.getText(), 'export function clamp(value: number, min: number, max: number): number {');
  });

  it('works the other way round: practise in a folder, target in a shadow inside it', async () => {
    const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-reverse-')));
    fs.mkdirSync(path.join(proj, '.slipstream/shadow'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.slipstream/link.json'), JSON.stringify({ target: '.slipstream/shadow' }));
    fs.writeFileSync(path.join(proj, '.slipstream/shadow/a.ts'), 'const a = 1;\n');
    const editor = await open(path.join(proj, 'a.ts'));
    placeCursor(editor, 0);
    await vscode.commands.executeCommand('slipstream.acceptLine');
    assert.strictEqual(editor.document.getText(), 'const a = 1;');
  });

  describe('hiding practice folders from search', () => {
    const userExclude = () =>
      vscode.workspace.getConfiguration('search').inspect<Record<string, boolean>>('exclude')?.globalValue ?? {};

    it('hides an in-project practice folder via user settings, keeping existing entries', async () => {
      await vscode.workspace
        .getConfiguration('search')
        .update('exclude', { '**/dist': true }, vscode.ConfigurationTarget.Global);
      assert.strictEqual(await hideFromSearch(practice()), true);
      assert.deepStrictEqual(userExclude(), { '**/dist': true, [SEARCH_PATTERN]: true });
      // Nothing written into the project.
      assert.strictEqual(fs.existsSync(path.join(project(), '.vscode/settings.json')), false);
    });

    it('stays out of the way for practice folders outside the workspace', async () => {
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-out-'));
      assert.strictEqual(await hideFromSearch(elsewhere), false);
    });

    it('can be turned off', async () => {
      const cfg = vscode.workspace.getConfiguration('slipstream');
      await cfg.update('hideFromSearch', false, vscode.ConfigurationTarget.Global);
      try {
        assert.strictEqual(await hideFromSearch(practice()), false);
      } finally {
        await cfg.update('hideFromSearch', undefined, vscode.ConfigurationTarget.Global);
      }
    });
  });

  describe('M1: tolerance and divergence', () => {
    it('ignores whitespace-only differences by default, and not in exact mode', async () => {
      fs.writeFileSync(path.join(project(), 'src/ws.ts'), 'if (a) {\n  b();\n}\n');
      const editor = await open(practice('src/ws.ts'), 'if (a)  {\n\tb();\n\n}');
      assert.deepStrictEqual(await changes(editor), []);

      const cfg = vscode.workspace.getConfiguration('slipstream');
      await cfg.update('whitespace', 'exact', vscode.ConfigurationTarget.Global);
      try {
        await eventually(async () => (await changes(editor)).length > 0);
      } finally {
        await cfg.update('whitespace', undefined, vscode.ConfigurationTarget.Global);
      }
    });

    it('shows and types over extra auto-indentation', async () => {
      const editor = await open(
        practice('src/math.ts'),
        'export function clamp(value: number, min: number, max: number): number {\n  if (min > max) {\n        ',
      );
      placeCursor(editor, editor.document.getText().length);
      await vscode.commands.executeCommand('slipstream.acceptWord');
      assert.strictEqual(editor.document.lineAt(2).text, '    throw');
    });

    it('offers quick fixes on a difference', async () => {
      fs.writeFileSync(path.join(project(), 'src/apply.ts'), 'const sum = 1;\nlog(sum);\n');
      const editor = await open(practice('src/apply.ts'), 'const total = 1;\n');
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        editor.document.uri,
        new vscode.Range(0, 7, 0, 7),
      );
      const titles = actions.map((a) => a.title);
      assert.ok(titles.includes('Slipstream: Use my version in the project'), titles.join(', '));
      assert.ok(titles.includes('Slipstream: Open in project to edit by hand'));
    });

    it('"use my version" writes my text into the project file and saves it', async () => {
      const projectFile = path.join(project(), 'src/apply.ts');
      fs.writeFileSync(projectFile, 'const sum = 1;\nlog(sum);\n');
      const editor = await open(practice('src/apply.ts'), 'const total = 1;\n');
      await vscode.commands.executeCommand('slipstream.applyMine', editor.document.uri, at(editor, 0, 7));

      assert.strictEqual(lf(fs.readFileSync(projectFile, 'utf8')), 'const total = 1;\nlog(sum);\n');
      // Only the line I haven't written yet is left.
      const left = await changes(editor);
      assert.deepStrictEqual(left.map((h) => lf(h.insert)), ['log(sum);\n']);
    });

    it('"remove from project" drops a line I won\'t write', async () => {
      const projectFile = path.join(project(), 'src/apply.ts');
      fs.writeFileSync(projectFile, 'a();\nb();\nc();\n');
      const editor = await open(practice('src/apply.ts'), 'a();\nc();\n');
      await vscode.commands.executeCommand('slipstream.applyMine', editor.document.uri, at(editor, 1, 0));
      assert.strictEqual(lf(fs.readFileSync(projectFile, 'utf8')), 'a();\nc();\n');
      assert.deepStrictEqual(await changes(editor), []);
    });

    it('"open in project" shows the project file at the difference', async () => {
      fs.writeFileSync(path.join(project(), 'src/apply.ts'), 'one();\nconst sum = 1;\n');
      const editor = await open(practice('src/apply.ts'), 'one();\nconst total = 1;\n');
      await vscode.commands.executeCommand('slipstream.openInTarget', editor.document.uri, at(editor, 1, 6));
      const shown = vscode.window.activeTextEditor!;
      assert.strictEqual(shown.document.uri.fsPath, path.join(project(), 'src/apply.ts'));
      assert.strictEqual(shown.document.getText(shown.selection), 'sum');
    });
  });

  describe('M2: steps', () => {
    // A small project of its own inside the workspace, so other tests' files don't interfere.
    const proj = () => path.join(project(), 'stepsdemo');
    const prac = (...p: string[]) => path.join(proj(), '.slipstream/practice', ...p);
    const write = (root: string, files: Record<string, string>) => {
      for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), text);
      }
    };
    const session = () => api().sessions.list().find((s) => s.link.practiceRoot === prac());
    const pending = () => (session()?.pending ?? []).map((s) => `${s.kind} ${s.from ? s.from + ' → ' : ''}${s.path}`);
    const node = (p: string) => {
      const s = session()!;
      return { type: 'step' as const, session: s, step: s.pending.find((x) => x.path === p)!, done: false };
    };

    before(async () => {
      const body = 'export function name() {\n  return 1;\n}\nexport const n = 2;\n';
      write(proj(), {
        'a.ts': 'one();\ntwo();\n',
        'b.ts': 'export const b = 1;\n',
        'new/name.ts': body.replace('2', '3'),
        'yarn.lock': '# lock',
      });
      write(prac(), { 'a.ts': 'one();\n', 'c.ts': 'gone();\n', 'old/name.ts': body });
      write(prac(), { '.slipstream/link.json': JSON.stringify({ target: '../..' }) });
      await eventually(async () => {
        await api().sessions.refresh();
        return !!session()?.scanned;
      });
    });

    it('lists what to move, create, modify, copy and delete', async () => {
      assert.deepStrictEqual(pending(), [
        'rename old/name.ts → new/name.ts',
        'modify a.ts',
        'create b.ts',
        'copy yarn.lock',
        'delete c.ts',
      ]);
    });

    it('typing a file to completion moves its step to done', async () => {
      const editor = await open(prac('a.ts'));
      placeCursor(editor, editor.document.getText().length);
      await vscode.commands.executeCommand('slipstream.acceptLine');
      await eventually(async () => session()!.done.some((s) => s.path === 'a.ts'));
      assert.ok(!pending().includes('modify a.ts'));
      await editor.document.save();
    });

    it('"create" makes the practice file and puts you where the ghost starts', async () => {
      await vscode.commands.executeCommand('slipstream.steps.createFile', node('b.ts'));
      assert.ok(fs.existsSync(prac('b.ts')));
      const editor = vscode.window.activeTextEditor!;
      assert.strictEqual(editor.document.uri.fsPath, prac('b.ts'));
      await vscode.commands.executeCommand('slipstream.acceptLine');
      assert.strictEqual(editor.document.getText(), 'export const b = 1;');
      await editor.document.save();
    });

    it('"move" moves the practice file, leaving the rest to type', async () => {
      await vscode.commands.executeCommand('slipstream.steps.movePracticeFile', node('new/name.ts'));
      assert.ok(!fs.existsSync(prac('old/name.ts')));
      assert.ok(fs.existsSync(prac('new/name.ts')));
      await eventually(async () => pending().includes('modify new/name.ts'));
    });

    it('"copy" copies a lockfile from the project', async () => {
      await vscode.commands.executeCommand('slipstream.steps.copyFromProject', node('yarn.lock'));
      assert.strictEqual(fs.readFileSync(prac('yarn.lock'), 'utf8'), '# lock');
    });

    it('"delete" removes a file the project no longer has', async () => {
      await vscode.commands.executeCommand('slipstream.steps.deletePracticeFile', node('c.ts'));
      assert.ok(!fs.existsSync(prac('c.ts')));
    });

    it('tracks progress across all of it', async () => {
      await api().sessions.refresh();
      const s = session()!;
      // Only typing is left: no moves, copies or deletes.
      assert.ok(pending().every((p) => p.startsWith('modify ') || p.startsWith('create ')), pending().join(', '));
      assert.ok(s.done.length >= 4, `done: ${s.done.map((d) => d.path).join(', ')}`);
    });

    it('next step goes to the next pending step of the practice folder you are in', async () => {
      write(proj(), { 'z.ts': 'last();\n' });
      await eventually(async () => pending().includes('create z.ts'));
      await open(prac('new/name.ts'));
      await vscode.commands.executeCommand('slipstream.nextStep');
      const paths = session()!.pending.map((s) => s.path);
      const next = paths[(paths.indexOf('new/name.ts') + 1) % paths.length];
      assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, prac(next));
    });
  });

  describe('M2.5: replaying git history', () => {
    const repo = () => path.join(project(), 'replaydemo');
    const prac = (...p: string[]) => path.join(repo(), '.slipstream/replay', ...p);
    const commits: string[] = [];
    const git = (...args: string[]) => execFileSync('git', ['-C', repo(), ...args], { stdio: 'pipe' }).toString().trim();
    const commit = (files: Record<string, string | null>, msg: string) => {
      for (const [rel, text] of Object.entries(files)) {
        if (text === null) fs.rmSync(path.join(repo(), rel));
        else fs.writeFileSync(path.join(repo(), rel), text);
      }
      git('add', '-A');
      git('commit', '-qm', msg);
      commits.push(git('rev-parse', 'HEAD'));
    };
    const session = () => api().sessions.list().find((s) => s.link.practiceRoot === prac());
    const pending = () => (session()?.pending ?? []).map((s) => `${s.kind} ${s.path}`);
    const ready = (ref: string) =>
      eventually(async () => {
        await api().sessions.refresh();
        return session()?.link.ref === ref && !!session()?.scanned;
      });

    before(async () => {
      fs.mkdirSync(repo(), { recursive: true });
      git('init', '-q');
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 't');
      commit({ 'a.ts': 'a1\n' }, 'first');
      commit({ 'a.ts': 'a1\na2\n', 'b.ts': 'b\n' }, 'add a2 and b');
      commit({ 'b.ts': null, 'c.ts': 'c\n' }, 'swap b for c');
      // Uncommitted work in the checkout must not leak into the replay.
      fs.writeFileSync(path.join(repo(), 'a.ts'), 'dirty working tree\n');
      await createReplay({ targetRoot: repo(), practiceRoot: prac(), commits: commits.slice(1) });
      await ready(commits[1]);
    });

    it('starts from the parent and lists what the commit changed', async () => {
      assert.strictEqual(lf(fs.readFileSync(prac('a.ts'), 'utf8')), 'a1\n');
      assert.deepStrictEqual(pending(), ['modify a.ts', 'create b.ts']);
      assert.strictEqual(session()!.subject, 'add a2 and b');
    });

    it('ghosts the commit, not the working tree', async () => {
      const editor = await open(prac('a.ts'));
      placeCursor(editor, editor.document.getText().length);
      await vscode.commands.executeCommand('slipstream.acceptLine');
      assert.strictEqual(lf(editor.document.getText()), 'a1\na2');
      await editor.document.save();
    });

    it('counts what Tab filled in separately from what you type', async () => {
      const before = { ...session()!.stats };
      assert.ok(before.accepted >= 2, JSON.stringify(before));
      const editor = await open(prac('a.ts'));
      await editor.edit((b) => b.insert(new vscode.Position(1, 2), 'xyz')); // a keystroke-ish edit, not a Tab
      assert.strictEqual(session()!.stats.typed, before.typed + 3);
      assert.strictEqual(session()!.stats.accepted, before.accepted);
      await editor.edit((b) => b.delete(new vscode.Range(1, 2, 1, 5)));
      await editor.document.save();
    });

    it('opens the commit\'s version read-only, and offers no "use my version"', async () => {
      const editor = await open(prac('a.ts'), 'a1\nX\n');
      try {
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
          'vscode.executeCodeActionProvider',
          editor.document.uri,
          new vscode.Range(1, 0, 1, 0),
        );
        // Only ours: VS Code itself may add AI actions ("Fix", "Explain") on some platforms.
        const ours = actions.map((a) => a.title).filter((t) => t.startsWith('Slipstream:'));
        assert.deepStrictEqual(ours, ["Slipstream: Show the commit's version"]);
        await vscode.commands.executeCommand('slipstream.openInTarget', editor.document.uri, at(editor, 1, 0));
        const shown = vscode.window.activeTextEditor!;
        assert.strictEqual(shown.document.uri.scheme, 'slipstream-git');
        assert.strictEqual(lf(shown.document.getText()), 'a1\na2\n');
      } finally {
        // Later tests need this commit's step done, so restore it even on failure.
        await vscode.window.showTextDocument(editor.document);
        await editor.edit((b) => b.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), 'a1\na2\n'));
        await editor.document.save();
      }
    });

    it('when a commit is done, "next commit" moves on to the next one', async () => {
      const s = session()!;
      const node = { type: 'step' as const, session: s, step: s.pending.find((x) => x.path === 'b.ts')!, done: false };
      await vscode.commands.executeCommand('slipstream.steps.copyFromProject', node);
      assert.strictEqual(lf(fs.readFileSync(prac('b.ts'), 'utf8')), 'b\n');
      await eventually(async () => {
        await api().sessions.refresh();
        return pending().length === 0;
      });

      await vscode.commands.executeCommand('slipstream.replayNextCommit', prac());
      await ready(commits[2]);
      assert.deepStrictEqual(pending(), ['create c.ts', 'delete b.ts']);
      assert.strictEqual(session()!.subject, 'swap b for c');
      assert.strictEqual(session()!.stats.accepted, 0); // a fresh session per commit
    });

    it('after the last commit, "continue" moves on to the current files', async () => {
      const s = session()!;
      const step = (p: string) => ({ type: 'step' as const, session: s, step: s.pending.find((x) => x.path === p)!, done: false });
      await vscode.commands.executeCommand('slipstream.steps.copyFromProject', step('c.ts'));
      await vscode.commands.executeCommand('slipstream.steps.deletePracticeFile', step('b.ts'));
      await eventually(async () => {
        await api().sessions.refresh();
        return pending().length === 0;
      });
      // The checkout has uncommitted work beyond the last replayed commit.
      assert.strictEqual(await moreAfterReplay(prac()), true);

      await vscode.commands.executeCommand('slipstream.replayContinue', prac());
      await eventually(async () => {
        await api().sessions.refresh();
        return session()?.link.ref === undefined && !!session()?.scanned;
      });
      assert.deepStrictEqual(pending(), ['modify a.ts']);
      const editor = await open(prac('a.ts'));
      placeCursor(editor, 0);
      await vscode.commands.executeCommand('slipstream.nextChange');
      await vscode.commands.executeCommand('slipstream.deleteMarked');
      await vscode.commands.executeCommand('slipstream.acceptLine');
      assert.strictEqual(editor.document.lineAt(0).text, 'dirty working tree');
    });
  });

  describe('M3: agent niceties', () => {
    it('orders steps by the agent\'s plan and shows its reasons, following edits to the plan', async () => {
      const proj = path.join(project(), 'plandemo');
      const prac = path.join(proj, '.slipstream/practice');
      for (const f of ['a.ts', 'b.ts', 'c.ts']) {
        fs.mkdirSync(proj, { recursive: true });
        fs.writeFileSync(path.join(proj, f), `${f}\n`);
      }
      fs.mkdirSync(path.join(prac, '.slipstream'), { recursive: true });
      fs.writeFileSync(path.join(prac, '.slipstream/link.json'), JSON.stringify({ target: '../..' }));
      fs.writeFileSync(path.join(proj, '.slipstream/plan.md'), '# Plan: Letters\n1. `c.ts`: first, everything needs it\n2. `a.ts`: then a\n');

      const session = () => api().sessions.list().find((s) => s.link.practiceRoot === prac);
      const order = () => (session()?.pending ?? []).map((s) => `${s.path}${s.reason ? `: ${s.reason}` : ''}`);
      await eventually(async () => {
        await api().sessions.refresh();
        return order().length === 3;
      });
      assert.deepStrictEqual(order(), ['c.ts: first, everything needs it', 'a.ts: then a', 'b.ts']);
      assert.strictEqual(session()!.plan?.title, 'Letters');

      fs.writeFileSync(path.join(proj, '.slipstream/plan.md'), '1. `b.ts`: changed my mind\n');
      await eventually(async () => {
        await api().sessions.refresh();
        return order()[0] === 'b.ts: changed my mind';
      });
      // The plan file itself is never a step.
      assert.ok(!order().some((o) => o.includes('plan.md')));
    });

    it('sets up the agent: personal instructions + deny rules, kept out of git, idempotent', async () => {
      const repo = path.join(project(), 'replaydemo'); // a git repo from the replay tests
      const args = { projectRoot: repo, choice: { instructions: 'CLAUDE.local.md', denyFolders: ['.slipstream/replay'] }, preview: false };
      await vscode.commands.executeCommand('slipstream.setUpAgent', args);
      await vscode.commands.executeCommand('slipstream.setUpAgent', args);

      const md = fs.readFileSync(path.join(repo, 'CLAUDE.local.md'), 'utf8');
      assert.strictEqual(md.split('<!-- slipstream:start -->').length, 2, 'one section only');
      assert.ok(md.includes('.slipstream/plan.md'));
      const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude/settings.local.json'), 'utf8'));
      assert.deepStrictEqual(settings.permissions.deny, ['Read(/.slipstream/replay/**)', 'Edit(/.slipstream/replay/**)']);
      const status = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all']).toString();
      assert.ok(!status.includes('CLAUDE.local.md') && !status.includes('settings.local.json'), status);
    });

    it('adds to an existing shared CLAUDE.md without disturbing it', async () => {
      const proj = path.join(project(), 'plandemo');
      fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# Team rules\n\nUse tabs.\n');
      await vscode.commands.executeCommand('slipstream.setUpAgent', { projectRoot: proj, choice: { instructions: 'CLAUDE.md' }, preview: false });
      const md = fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8');
      assert.ok(md.startsWith('# Team rules\n\nUse tabs.\n\n<!-- slipstream:start -->'), md.slice(0, 80));
    });
  });

  describe('M5: modes, dependency order, MCP', () => {
    const cfg = () => vscode.workspace.getConfiguration('slipstream');
    const ghostNow = async (editor: vscode.TextEditor) => {
      const items = await api().ghost.provideInlineCompletionItems(editor.document, editor.selection.active);
      return items?.[0]?.insertText as string | undefined;
    };
    afterEach(async () => {
      await cfg().update('mode', undefined, vscode.ConfigurationTarget.Global);
      await cfg().update('revealDelaySeconds', undefined, vscode.ConfigurationTarget.Global);
    });

    it('delayed mode shows the ghost only after you have been stuck for a while', async () => {
      await cfg().update('mode', 'delayed', vscode.ConfigurationTarget.Global);
      await cfg().update('revealDelaySeconds', 0.6, vscode.ConfigurationTarget.Global);
      const editor = await open(practice('src/math.ts'), 'export ');
      placeCursor(editor, editor.document.getText().length);
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(await ghostNow(editor), undefined);
      await new Promise((r) => setTimeout(r, 800));
      assert.ok((await ghostNow(editor))?.startsWith('function clamp'));
    });

    it('hint mode never shows the code, but Tab still peeks a word', async () => {
      await cfg().update('mode', 'hint', vscode.ConfigurationTarget.Global);
      const editor = await open(practice('src/math.ts'), '');
      placeCursor(editor, 0);
      assert.strictEqual(await ghostNow(editor), undefined);
      await vscode.commands.executeCommand('slipstream.acceptWord');
      assert.strictEqual(editor.document.getText(), 'export');
    });

    it('without a plan, orders steps so imported files come first, and says what each adds', async () => {
      const proj = path.join(project(), 'depsdemo');
      const prac = path.join(proj, '.slipstream/practice');
      fs.mkdirSync(path.join(prac, '.slipstream'), { recursive: true });
      fs.writeFileSync(path.join(prac, '.slipstream/link.json'), JSON.stringify({ target: '../..' }));
      fs.writeFileSync(path.join(proj, 'app.ts'), "import { Opts } from './types';\nexport function main(o: Opts) {}\n");
      fs.writeFileSync(path.join(proj, 'types.ts'), 'export interface Opts {}\n');
      const session = () => api().sessions.list().find((x) => x.link.practiceRoot === prac);
      await eventually(async () => {
        await api().sessions.refresh();
        return session()?.pending.length === 2;
      });
      assert.deepStrictEqual(
        session()!.pending.map((x) => `${x.path}: ${x.symbols?.join(',')}`),
        ['types.ts: Opts', 'app.ts: main'],
      );
    });

    it('connect your agent: installs the MCP server at a stable path and gives the Claude Code command', async () => {
      const cmd = await vscode.commands.executeCommand<string>('slipstream.connectAgent', { show: false });
      const script = JSON.parse(cmd.slice(cmd.indexOf('node ') + 5));
      assert.ok(cmd.startsWith('claude mcp add slipstream --scope local -- node '), cmd);
      assert.ok(fs.existsSync(script), script);
      assert.ok(!script.includes(path.resolve(__dirname, '../../..')), 'not inside the extension folder');
    });
  });

  describe('M6: portable practice repos', () => {
    const sh = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-m6-int-')));
    const remote = path.join(root, 'remote.git');
    const work = path.join(root, 'work');
    // Inside the workspace, so the Steps view finds it; its committed target doesn't exist here.
    const prac = (...p: string[]) => path.join(project(), 'portable-practice', ...p);
    const session = () => api().sessions.list().find((x) => x.link.practiceRoot === prac());
    const pending = () => (session()?.pending ?? []).map((x) => `${x.kind} ${x.path}`);

    before(async () => {
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
      execFileSync('git', ['clone', '-q', remote, work], { stdio: 'pipe' });
      fs.mkdirSync(path.join(work, 'app'), { recursive: true });
      fs.writeFileSync(path.join(work, 'app/hello.ts'), 'export const hello = 1;\n');
      sh(work, 'add', '-A');
      sh(work, 'commit', '-qm', 'hello');
      sh(work, 'push', '-q', 'origin', 'main');
      fs.mkdirSync(prac('.slipstream'), { recursive: true });
      fs.writeFileSync(
        prac('.slipstream/link.json'),
        JSON.stringify({ target: '/Users/someone-else/project/app', remote: { url: remote, ref: 'main', path: 'app' } }),
      );
      await eventually(async () => {
        await api().sessions.refresh();
        return session()?.link.source === 'remote' && pending().length > 0;
      }, 15000);
    });

    it('clones the remote and practises against it', async () => {
      assert.deepStrictEqual(pending(), ['create hello.ts']);
      await vscode.commands.executeCommand('slipstream.steps.createFile', {
        type: 'step',
        session: session()!,
        step: session()!.pending[0],
        done: false,
      });
      await vscode.commands.executeCommand('slipstream.acceptLine');
      assert.strictEqual(vscode.window.activeTextEditor!.document.getText(), 'export const hello = 1;');
      await vscode.window.activeTextEditor!.document.save();
    });

    it('follows the branch when the remote moves', async () => {
      fs.writeFileSync(path.join(work, 'app/later.ts'), 'export const later = 2;\n');
      sh(work, 'add', '-A');
      sh(work, 'commit', '-qm', 'later');
      sh(work, 'push', '-q', 'origin', 'main');
      await vscode.commands.executeCommand('slipstream.fetchRemotes');
      await eventually(async () => pending().includes('create later.ts'), 15000);
      assert.strictEqual(session()!.link.ref, sh(work, 'rev-parse', 'HEAD'));
    });

    it('uses a local checkout on this machine when told to', async () => {
      await vscode.commands.executeCommand('slipstream.pickLocalCheckout', prac(), path.join(work, 'app'));
      await eventually(async () => {
        await api().sessions.refresh();
        return session()?.link.source === 'override';
      });
      assert.strictEqual(session()!.link.targetRoot, path.join(work, 'app'));
      assert.strictEqual(session()!.link.ref, undefined); // the working tree, live
      await vscode.commands.executeCommand('slipstream.clearLocalCheckout', prac());
      await eventually(async () => {
        await api().sessions.refresh();
        return session()?.link.source === 'remote';
      });
    });

    it('clones a practice repository and resolves it through the remote', async () => {
      const practiceRepo = path.join(root, 'practice-repo');
      fs.mkdirSync(path.join(practiceRepo, '.slipstream'), { recursive: true });
      fs.writeFileSync(
        path.join(practiceRepo, '.slipstream/link.json'),
        JSON.stringify({ target: '../work/app', remote: { url: remote, ref: 'main', path: 'app' } }),
      );
      sh(root, 'init', '-q', '-b', 'main', practiceRepo);
      sh(practiceRepo, 'add', '-A');
      sh(practiceRepo, 'commit', '-qm', 'practice');
      const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-m6-clone-')));
      const dest = await vscode.commands.executeCommand<string>('slipstream.clonePracticeRepo', { url: practiceRepo, parent, show: false });
      assert.strictEqual(dest, path.join(parent, 'practice-repo'));
      // '../work/app' doesn't exist next to the clone, so the remote is the target.
      const { readLink } = await import('../../../src/target/links');
      assert.strictEqual(readLink(dest)!.source, 'remote');
    });
  });

  describe('M7: typing speed and time left', () => {
    const proj = () => path.join(project(), 'speeddemo');
    const prac = (...p: string[]) => path.join(proj(), '.slipstream/practice', ...p);
    const session = () => api().sessions.list().find((x) => x.link.practiceRoot === prac());
    const stats = () => session()!.stats;
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let editor: vscode.TextEditor;

    before(async () => {
      fs.mkdirSync(prac('.slipstream'), { recursive: true });
      fs.writeFileSync(prac('.slipstream/link.json'), JSON.stringify({ target: '../..' }));
      fs.writeFileSync(path.join(proj(), 'speed.ts'), 'export const speed = 1;\nexport const more = 2;\n');
      fs.writeFileSync(prac('speed.ts'), '');
      await eventually(async () => {
        await api().sessions.refresh();
        return !!session()?.scanned;
      });
      editor = await open(prac('speed.ts'));
    });

    it('counts real keystrokes', async () => {
      const before = stats().keys ?? 0;
      for (const ch of 'export') {
        const end = editor.document.positionAt(editor.document.getText().length);
        await editor.edit((b) => b.insert(end, ch));
        await pause(20);
      }
      assert.strictEqual((stats().keys ?? 0) - before, 6);
      assert.ok((stats().activeMs ?? 0) > 0);
    });

    it('does not count Tab or Shift+Tab', async () => {
      const keys = stats().keys ?? 0;
      const accepted = stats().accepted;
      placeCursor(editor, editor.document.getText().length);
      await vscode.commands.executeCommand('slipstream.acceptWord');
      await vscode.commands.executeCommand('slipstream.acceptLine');
      assert.strictEqual(stats().keys ?? 0, keys);
      assert.ok(stats().accepted > accepted);
    });

    it('counts Backspace as a correction, and not Delete Marked or a paste', async () => {
      const k = { ...stats() };
      const end = () => editor.document.positionAt(editor.document.getText().length);
      await editor.edit((b) => b.insert(end(), 'x'));
      await editor.edit((b) => b.delete(new vscode.Range(end().translate(0, -1), end()))); // Backspace
      assert.strictEqual((stats().corrections ?? 0) - (k.corrections ?? 0), 1);

      await editor.edit((b) => b.insert(end(), 'const pasted = "a whole line";'));
      assert.strictEqual((stats().keys ?? 0) - (k.keys ?? 0), 2); // the x and the Backspace, not the paste

      placeCursor(editor, editor.document.getText().indexOf('const pasted'));
      await vscode.commands.executeCommand('slipstream.deleteMarked');
      assert.strictEqual((stats().corrections ?? 0) - (k.corrections ?? 0), 1);
    });

    it('estimates the time left and reports it', async () => {
      await api().sessions.refresh();
      const pace = session()!.pace;
      assert.ok(pace.charsLeft > 0, JSON.stringify(pace));
      assert.ok(pace.session.ms > 0);
      const md = await vscode.commands.executeCommand<string>('slipstream.showStats', { show: false });
      assert.ok(md.includes(prac()), md);
      assert.ok(md.includes('characters left'), md);
    });
  });
});
