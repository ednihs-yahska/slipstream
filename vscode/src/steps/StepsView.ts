import * as path from 'path';
import * as vscode from 'vscode';
import { targetUriFor } from '../target/gitTarget';
import { TargetStore } from '../target/TargetStore';
import { leftText, paceLines } from '../stats/report';
import { readBlobAtRef } from './scan';
import { Session, Sessions, summarize } from './Sessions';
import { Step } from './StepModel';

export type Node =
  | { type: 'session'; session: Session }
  | { type: 'step'; session: Session; step: Step; done: boolean };

const ICONS: Record<Step['kind'], string> = {
  create: 'new-file',
  modify: 'edit',
  delete: 'trash',
  rename: 'arrow-right',
  copy: 'copy',
};

export class StepsView implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly sessions: Sessions) {
    sessions.onDidChange(() => this.emitter.fire());
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.sessions.list().map((session) => ({ type: 'session', session }));
    if (node.type !== 'session') return [];
    const { session } = node;
    return [
      ...session.pending.map((step): Node => ({ type: 'step', session, step, done: false })),
      ...session.done.map((step): Node => ({ type: 'step', session, step, done: true })),
    ];
  }

  getParent(node: Node): Node | undefined {
    return node.type === 'step' ? { type: 'session', session: node.session } : undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === 'session') {
      const { link, pending, done, scanned, subject, plan } = node.session;
      const total = pending.length + done.length;
      const progress = scanned ? (total === 0 ? 'matches' : `${done.length}/${total} done`) : 'scanning…';
      const replay = link.replay;
      const remoteName = link.remote ? link.remote.url.replace(/\.git\/?$/, '').split(/[/:]/).slice(-2).join('/') : undefined;
      const label = link.pinned && link.ref
        ? `${replay ? `Commit ${replay.index + 1}/${replay.commits.length}` : 'Commit'} ${link.ref.slice(0, 7)}${subject ? `: ${subject}` : ''}`
        : (plan?.title ?? path.basename(link.practiceRoot));
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
      const where =
        link.source === 'remote' && !link.pinned
          ? `→ ${remoteName}@${link.refLabel}${link.ref && link.ref !== link.refLabel ? ` (${link.ref.slice(0, 7)})` : ''}`
          : link.pinned
            ? undefined
            : `→ ${path.basename(link.targetRoot)}`;
      const showSpeed = vscode.workspace.getConfiguration('slipstream').get<boolean>('showTypingSpeed', true);
      const left = showSpeed && pending.length ? leftText(node.session.pace) : '';
      item.description = [where, progress, left].filter(Boolean).join(' · ');
      item.tooltip = [
        `Practice: ${link.practiceRoot}`,
        link.source === 'remote'
          ? `Target:   ${link.remote!.url}${link.remote!.path ? ` (${link.remote!.path}/)` : ''} @ ${link.refLabel}${link.ref ? ` = ${link.ref.slice(0, 10)}` : ''} — remote, cached`
          : `Target:   ${link.targetRoot}${link.ref ? ` @ ${link.ref.slice(0, 10)}` : ''}${link.source === 'override' ? ' — this machine (link.local.json)' : ''}`,
        ...(subject ? [`Commit:   ${subject}`] : []),
        ...(plan ? [`Plan:     ${plan.title ?? '(untitled)'}, ${plan.entries.length} file${plan.entries.length === 1 ? '' : 's'}, from .slipstream/plan.md`] : []),
        ...(node.session.stats.typed + node.session.stats.accepted > 0 ? ['', summarize(node.session.stats)] : []),
        ...(vscode.workspace.getConfiguration('slipstream').get<boolean>('showTypingSpeed', true) ? ['', ...paceLines(node.session.pace)] : []),
      ].join('\n');
      item.iconPath = new vscode.ThemeIcon(scanned && pending.length === 0 ? 'pass' : link.pinned ? 'git-commit' : link.source === 'remote' ? 'cloud' : 'mortar-board');
      item.contextValue = !link.pinned
        ? link.remote ? 'session-remote' : 'session'
        : replay && replay.index + 1 < replay.commits.length ? 'session-replay' : 'session-replay-end';
      item.id = `session:${link.practiceRoot}`;
      return item;
    }

    const { step, done, session } = node;
    const item = new vscode.TreeItem(step.path, vscode.TreeItemCollapsibleState.None);
    item.id = `${done ? 'done' : 'todo'}:${session.link.practiceRoot}:${step.kind}:${step.from ?? ''}:${step.path}`;
    const why = step.reason ?? (step.symbols?.length ? `adds ${step.symbols.slice(0, 3).join(', ')}${step.symbols.length > 3 ? ', …' : ''}` : undefined);
    item.description = done ? 'done' : why ? `${describe(step)} · ${why}` : describe(step);
    item.iconPath = done
      ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
      : new vscode.ThemeIcon(ICONS[step.kind]);
    item.contextValue = done ? 'step-done' : `step-${step.kind}`;
    const lines = [
      ...(step.reason ? [`**Why:** ${step.reason}`] : []),
      ...(step.symbols?.length ? [`**Adds:** ${step.symbols.map((x) => `\`${x}\``).join(', ')}`] : []),
      ...(!done && step.charsLeft ? [`**To type:** ${step.charsLeft.toLocaleString()} characters`] : []),
      tooltip(step, done),
    ];
    item.tooltip = new vscode.MarkdownString(lines.join('\n\n'));
    item.command = { title: 'Open', command: 'slipstream.steps.open', arguments: [node] };
    return item;
  }
}

function describe(step: Step): string {
  switch (step.kind) {
    case 'create':
      return `create · ${step.changes} line${step.changes === 1 ? '' : 's'} to type`;
    case 'modify':
      return `${step.changes} change${step.changes === 1 ? '' : 's'} left`;
    case 'delete':
      return 'delete';
    case 'rename':
      return `move from ${step.from}`;
    case 'copy':
      return 'copy from project';
  }
}

function tooltip(step: Step, done: boolean): string {
  if (done) return 'Done. Click to open.';
  switch (step.kind) {
    case 'create':
      return 'Only in the project. Click to create the file in your practice folder and start typing.';
    case 'modify':
      return 'Differs from the project. Click to jump to the first change.';
    case 'delete':
      return 'Not in the project any more. Delete it from your practice folder (trash button).';
    case 'rename':
      return `The project moved ${step.from} to ${step.path}. Move it (arrow button), then type any remaining changes.`;
    case 'copy':
      return 'Binary, very large, or a lockfile: not worth typing. Copy it from the project (copy button).';
  }
}

/** Absolute practice and project paths for a step. */
export function stepPaths(node: Extract<Node, { type: 'step' }>) {
  const { link } = node.session;
  return {
    practice: vscode.Uri.file(path.join(link.practiceRoot, node.step.path)),
    target: targetUriFor(link, node.step.path),
    from: node.step.from ? vscode.Uri.file(path.join(link.practiceRoot, node.step.from)) : undefined,
  };
}

/** Commands behind the Steps view. */
export function registerStepCommands(store: TargetStore, sessions: Sessions, view: vscode.TreeView<Node>): vscode.Disposable[] {
  const asStep = (node?: Node) => {
    const n = node ?? view.selection[0];
    return n?.type === 'step' ? n : undefined;
  };

  const openAndJump = async (uri: vscode.Uri) => {
    const editor = await vscode.window.showTextDocument(uri);
    const hunks = await store.getHunks(editor.document);
    const first = hunks?.[0];
    const pos = editor.document.positionAt(first ? first.start : 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  };

  const exists = async (uri: vscode.Uri) => {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  };

  const createFile = async (node?: Node) => {
    const n = asStep(node);
    if (!n) return;
    const { practice } = stepPaths(n);
    if (!(await exists(practice))) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(practice.fsPath)));
      await vscode.workspace.fs.writeFile(practice, new Uint8Array());
    }
    await openAndJump(practice);
  };

  const open = async (node?: Node) => {
    const n = asStep(node);
    if (!n) return;
    const { practice, target, from } = stepPaths(n);
    if (n.done) {
      if (await exists(practice)) await vscode.window.showTextDocument(practice);
      return;
    }
    switch (n.step.kind) {
      case 'create':
        return createFile(n);
      case 'modify':
        return openAndJump(practice);
      case 'copy':
        return vscode.commands.executeCommand('vscode.open', target, { preview: true });
      case 'delete':
        return vscode.window.showTextDocument(practice, { preview: true });
      case 'rename': {
        const choice = await vscode.window.showInformationMessage(
          `The project moved ${n.step.from} to ${n.step.path}. Move your practice file too?`,
          'Move It',
          'Show Old File',
        );
        if (choice === 'Move It') return move(n);
        if (choice === 'Show Old File' && from) return vscode.window.showTextDocument(from, { preview: true });
      }
    }
  };

  const move = async (node?: Node) => {
    const n = asStep(node);
    if (!n?.step.from) return;
    const { practice, from } = stepPaths(n);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(practice.fsPath)));
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(from!, practice, { overwrite: false });
    if (!(await vscode.workspace.applyEdit(edit))) {
      void vscode.window.showErrorMessage(`Could not move ${n.step.from} to ${n.step.path}.`);
      return;
    }
    await sessions.refresh();
    await openAndJump(practice);
  };

  const deletePractice = async (node?: Node) => {
    const n = asStep(node);
    if (!n) return;
    await vscode.workspace.fs.delete(stepPaths(n).practice, { useTrash: true });
    await sessions.refresh();
  };

  const copyFromProject = async (node?: Node) => {
    const n = asStep(node);
    if (!n) return;
    const { practice, target } = stepPaths(n);
    if (n.step.kind === 'modify' || n.step.kind === 'rename') {
      const ok = await vscode.window.showWarningMessage(
        `Replace your practice ${n.step.path} with the project's version? You won't type the remaining changes.`,
        { modal: true },
        'Replace',
      );
      if (ok !== 'Replace') return;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(practice.fsPath)));
    const { link } = n.session;
    if (link.ref) {
      const bytes = await readBlobAtRef(link.targetRoot, link.ref, n.step.path);
      if (bytes) await vscode.workspace.fs.writeFile(practice, bytes);
    } else {
      await vscode.workspace.fs.copy(target, practice, { overwrite: true });
    }
    await sessions.refresh();
  };

  const showDiff = async (node?: Node) => {
    const n = asStep(node);
    if (!n) return;
    const { practice, target, from } = stepPaths(n);
    const left = n.step.kind === 'rename' ? from! : practice;
    await vscode.commands.executeCommand('vscode.diff', left, target, `${n.step.path}: Practice ↔ Project`);
  };

  const openProjectFile = async (node?: Node) => {
    const n = asStep(node);
    if (n) await vscode.window.showTextDocument(stepPaths(n).target, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  };

  const nextStep = async () => {
    const editor = vscode.window.activeTextEditor;
    // The practice folder you're typing in, else the one selected in the Steps view, else the first.
    const selected = view.selection[0]?.session.link.practiceRoot;
    const session =
      (editor && sessions.sessionFor(editor.document.uri.fsPath)) ??
      sessions.list().find((s) => s.link.practiceRoot === selected) ??
      sessions.list().find((s) => s.pending.length > 0) ??
      sessions.list()[0];
    if (!session) {
      void vscode.window.showInformationMessage('No practice folder here yet. Run "Slipstream: Start Practice".');
      return;
    }
    const current = editor && session.pending.findIndex((s) => stepPaths({ type: 'step', session, step: s, done: false }).practice.fsPath === editor.document.uri.fsPath);
    // The step after the current file's (Alt+] moves between changes within a file).
    const step = current !== undefined && current >= 0 ? session.pending[(current + 1) % session.pending.length] : session.pending[0];
    if (!step) {
      void vscode.window.showInformationMessage('All steps done.');
      return;
    }
    const node: Node = { type: 'step', session, step, done: false };
    await view.reveal(node, { select: true, focus: false }).then(undefined, () => undefined);
    await open(node);
  };

  return [
    vscode.commands.registerCommand('slipstream.steps.open', open),
    vscode.commands.registerCommand('slipstream.steps.createFile', createFile),
    vscode.commands.registerCommand('slipstream.steps.movePracticeFile', move),
    vscode.commands.registerCommand('slipstream.steps.deletePracticeFile', deletePractice),
    vscode.commands.registerCommand('slipstream.steps.copyFromProject', copyFromProject),
    vscode.commands.registerCommand('slipstream.steps.showDiff', showDiff),
    vscode.commands.registerCommand('slipstream.steps.openProjectFile', openProjectFile),
    vscode.commands.registerCommand('slipstream.steps.refresh', () => sessions.refresh()),
    vscode.commands.registerCommand('slipstream.steps.resetProgress', (node?: Node) => {
      const s = node?.type === 'session' ? node.session : sessions.list()[0];
      if (s) return sessions.resetProgress(s.link.practiceRoot);
    }),
    vscode.commands.registerCommand('slipstream.nextStep', nextStep),
  ];
}
