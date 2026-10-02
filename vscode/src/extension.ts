import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Hunk } from './diff/hunks';
import { nextWord, restOfLine } from './ghost/acceptance';
import { Decorations } from './ghost/Decorations';
import { connectAgent, refreshMcpServer } from './agent/mcpCommand';
import { setUpAgent, SetupArgs } from './agent/setupCommand';
import { initLog } from './log';
import { leftText, speedText, statsMarkdown } from './stats/report';
import { noticeOtherProviders } from './ghost/coexistence';
import { applyMine, DivergenceActions, openInTarget } from './ghost/Divergence';
import { ghostAtCursor, ghostKey, GhostTextProvider } from './ghost/GhostTextProvider';
import { guidanceText } from './ghost/guidance';
import { hintFor } from './ghost/hint';
import { chooseMode, currentMode, Reveal } from './ghost/modes';
import { linkPracticeFolder, openPracticeFolder, startPractice } from './practice/practice';
import { clearLocalCheckout, clonePracticeRepo, pickLocalCheckout, storeProgress } from './practice/portable';
import { replayCommit, replayContinue, replayNextCommit, replayRange } from './practice/replay';
import { GIT_SCHEME, GitTargetProvider } from './target/gitTarget';
import { Session, Sessions } from './steps/Sessions';
import { Node, registerStepCommands, StepsView } from './steps/StepsView';
import { TargetStore } from './target/TargetStore';

/** Returned from `activate`; used by the integration tests. */
export interface SlipstreamApi {
  store: TargetStore;
  sessions: Sessions;
  ghost: GhostTextProvider;
  /** The hint shown after the cursor, if any (for tests). */
  hint: () => string | undefined;
}

export function activate(context: vscode.ExtensionContext): SlipstreamApi {
  context.subscriptions.push(initLog());
  const store = new TargetStore();
  const decorations = new Decorations();
  const sessions = new Sessions(context, store);
  const stepsView = vscode.window.createTreeView('slipstream.steps', {
    treeDataProvider: new StepsView(sessions),
    showCollapseAll: true,
  });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  // Delayed mode: when the reveal time comes, refresh (which re-triggers the ghost).
  const reveal = new Reveal(() => void refresh());
  const ghostProvider = new GhostTextProvider(store, reveal);
  let refreshSeq = 0;
  let lastHint: string | undefined;
  const refresh = async () => {
    const seq = ++refreshSeq;
    const editor = vscode.window.activeTextEditor;
    const hunks = editor ? await store.getHunks(editor.document) : undefined;
    const ghost = editor && hunks ? await ghostAtCursor(store, editor) : undefined;
    if (seq !== refreshSeq) return; // a newer refresh superseded this one

    await vscode.commands.executeCommand('setContext', 'slipstream.hasTarget', !!hunks);
    await vscode.commands.executeCommand('setContext', 'slipstream.ghostVisible', !!ghost);

    if (!editor || !hunks) {
      if (editor) decorations.clear(editor);
      status.hide();
      return;
    }
    const mode = currentMode();
    const key = ghost && ghostKey(editor.document, ghost);
    reveal.at(key);
    const hidden = !!ghost && (mode === 'hint' || (mode === 'delayed' && !reveal.revealed(key!)));
    const session0 = sessions.sessionFor(editor.document.uri.fsPath);
    const hint = hidden ? (mode === 'hint' ? hintFor(ghost!.text) : '◂ …') : !ghost ? guidance(editor, hunks, session0) : undefined;
    lastHint = hint;
    decorations.update(editor, hunks, ghost?.hunk, hint);
    const session = sessions.sessionFor(editor.document.uri.fsPath);
    const total = session ? session.pending.length + session.done.length : 0;
    const progress = session && total > 0 ? ` · ${session.done.length}/${total} steps` : '';
    const modeIcon = mode === 'hint' ? '$(lightbulb) ' : mode === 'delayed' ? '$(watch) ' : '';
    const showSpeed = vscode.workspace.getConfiguration('slipstream').get<boolean>('showTypingSpeed', true);
    const pace = showSpeed && session ? [speedText(session.pace), leftText(session.pace)].filter(Boolean).join(' · ') : '';
    status.text =
      modeIcon +
      (hunks.length === 0 ? '$(check) File done' : `$(keyboard) ${hunks.length} change${hunks.length === 1 ? '' : 's'} left`) +
      progress +
      (pace ? ` · ${pace}` : '');
    status.tooltip = hunks.length === 0 ? 'Slipstream: click for the next step' : 'Slipstream: click to go to the next change';
    status.command = hunks.length === 0 ? 'slipstream.nextStep' : 'slipstream.nextChange';
    status.show();
    void noticeOtherProviders(context);
    if (ghost && !hidden) await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    if (hidden) await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
  };

  const accept = (pick: (ghost: string, textAfterCursor: string) => string, fallback: string) => async () => {
    const editor = vscode.window.activeTextEditor;
    const ghost = editor ? await ghostAtCursor(store, editor) : undefined;
    if (!editor || !ghost) {
      await vscode.commands.executeCommand(fallback);
      return;
    }
    const at = editor.selection.active;
    const text = pick(ghost.text, editor.document.lineAt(at.line).text.slice(at.character));
    // Types over any extra indentation between the missing text and the cursor.
    const from = editor.document.positionAt(ghost.replaceFrom);
    sessions.expectAccepted(editor.document.uri, text);
    await editor.edit((b) => b.replace(new vscode.Range(from, at), text));
    await refresh();
  };

  const jump = (direction: 1 | -1) => async () => {
    const editor = vscode.window.activeTextEditor;
    const hunks = editor ? await store.getHunks(editor.document) : undefined;
    if (!editor || !hunks?.length) return;
    const target = pickHunk(hunks, editor.document.offsetAt(editor.selection.active), direction);
    const pos = editor.document.positionAt(target.start);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    await refresh();
  };

  // Unbound by default: deleting is meant to be done by hand.
  const deleteMarked = async () => {
    const editor = vscode.window.activeTextEditor;
    const hunks = editor ? await store.getHunks(editor.document) : undefined;
    if (!editor || !hunks) return;
    const cursor = editor.document.offsetAt(editor.selection.active);
    const h = hunks.find((h) => h.end > h.start && h.start <= cursor && cursor <= h.end);
    if (!h) return;
    const doc = editor.document;
    sessions.expectInternal(doc.uri); // not a Backspace: don't count it as a correction
    await editor.edit((b) => b.delete(new vscode.Range(doc.positionAt(h.start), doc.positionAt(h.end))));
    await refresh();
  };

  const rootOf = (arg?: string | Node) => (typeof arg === 'string' ? arg : arg?.type === 'session' ? arg.session.link.practiceRoot : undefined);
  /** The session a replay command is about: the one passed in, else the one you're typing in. */
  const replaySession = (arg?: string | Node) => {
    const root = rootOf(arg);
    const editor = vscode.window.activeTextEditor;
    return root ? sessions.list().find((x) => x.link.practiceRoot === root) : editor && sessions.sessionFor(editor.document.uri.fsPath);
  };

  context.subscriptions.push(
    store,
    sessions,
    stepsView,
    ...registerStepCommands(store, sessions, stepsView),
    sessions.onDidChange(refresh),
    decorations,
    status,
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, ghostProvider),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new DivergenceActions(store), {
      providedCodeActionKinds: DivergenceActions.kinds,
    }),

    vscode.commands.registerCommand('slipstream.acceptWord', accept(nextWord, 'tab')),
    vscode.commands.registerCommand('slipstream.acceptLine', accept(restOfLine, 'outdent')),
    vscode.commands.registerCommand('slipstream.nextChange', jump(1)),
    vscode.commands.registerCommand('slipstream.previousChange', jump(-1)),
    vscode.commands.registerCommand('slipstream.deleteMarked', deleteMarked),
    vscode.commands.registerCommand('slipstream.applyMine', (uri?: vscode.Uri, offset?: number) => applyMine(store, uri, offset)),
    vscode.commands.registerCommand('slipstream.openInTarget', (uri?: vscode.Uri, offset?: number) => openInTarget(store, uri, offset)),

    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitTargetProvider()),
    reveal,
    vscode.commands.registerCommand('slipstream.chooseMode', chooseMode),
    vscode.commands.registerCommand('slipstream.showStats', async (opts?: { show?: boolean }) => {
      const md = statsMarkdown(sessions.list());
      if (opts?.show === false) return md;
      const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
      await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
      return md;
    }),
    vscode.commands.registerCommand('slipstream.connectAgent', (opts?: { show?: boolean }) => connectAgent(context, opts)),
    vscode.commands.registerCommand('slipstream.setUpAgent', (args?: SetupArgs) => setUpAgent(sessions, args)),
    vscode.commands.registerCommand('slipstream.startPractice', () => startPractice(context, store)),
    vscode.commands.registerCommand('slipstream.clonePracticeRepo', (args?: { url?: string; parent?: string; show?: boolean }) =>
      clonePracticeRepo(context, store, args),
    ),
    vscode.commands.registerCommand('slipstream.pickLocalCheckout', (arg?: string | Node, checkout?: string) =>
      pickLocalCheckout(store, rootOf(arg), checkout),
    ),
    vscode.commands.registerCommand('slipstream.clearLocalCheckout', (arg?: string | Node) => clearLocalCheckout(store, rootOf(arg))),
    vscode.commands.registerCommand('slipstream.fetchRemotes', async () => {
      const n = await sessions.fetchRemotes();
      if (n === 0) void vscode.window.showInformationMessage('No practice folder here uses a remote target.');
    }),
    vscode.commands.registerCommand('slipstream.storeProgress', (arg?: string | Node) => storeProgress(sessions, rootOf(arg))),
    vscode.commands.registerCommand('slipstream.replayCommit', () => replayCommit(context, store)),
    vscode.commands.registerCommand('slipstream.replayRange', () => replayRange(context, store)),
    vscode.commands.registerCommand('slipstream.replayNextCommit', (arg?: string | Node) => {
      const session = replaySession(arg);
      return replayNextCommit(store, session?.link.practiceRoot ?? rootOf(arg), session?.pending.length ?? 0);
    }),
    vscode.commands.registerCommand('slipstream.replayContinue', (arg?: string | Node) => {
      const session = replaySession(arg);
      return replayContinue(store, session?.link.practiceRoot ?? rootOf(arg), session?.pending.length ?? 0);
    }),
    vscode.commands.registerCommand('slipstream.linkPracticeFolder', () => linkPracticeFolder(context, store)),
    vscode.commands.registerCommand('slipstream.openPracticeFolder', () => openPracticeFolder(context)),

    vscode.commands.registerCommand('slipstream.setTarget', async (target?: vscode.Uri) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      target ??= (await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Use as target' }))?.[0];
      if (!target) return;
      store.setExplicitTarget(editor.document.uri, target);
      await refresh();
    }),
    vscode.commands.registerCommand('slipstream.clearTarget', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      store.clearExplicitTarget(editor.document.uri);
      await refresh();
    }),
    vscode.commands.registerCommand('slipstream.showTargetDiff', async () => {
      const editor = vscode.window.activeTextEditor;
      const target = editor && store.resolveTargetUri(editor.document);
      if (!editor || !target) return;
      await vscode.commands.executeCommand('vscode.diff', editor.document.uri, target, 'Practice ↔ Target');
    }),

    store.onDidChangeTargets(refresh),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('slipstream')) store.invalidate();
    }),
    vscode.window.onDidChangeActiveTextEditor(refresh),
    vscode.window.onDidChangeTextEditorSelection(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) void refresh();
    }),
  );

  void refresh();
  void refreshMcpServer(context);
  return { store, sessions, ghost: ghostProvider, hint: () => lastHint };
}

function pickHunk(hunks: readonly Hunk[], cursor: number, direction: 1 | -1): Hunk {
  if (direction === 1) return hunks.find((h) => h.start > cursor) ?? hunks[0];
  return [...hunks].reverse().find((h) => h.start < cursor) ?? hunks[hunks.length - 1];
}

export function deactivate() {}

/**
 * Nothing to type at the cursor: say what to do next, in the ghost text's place.
 * Only at the end of a line (never between characters of code), and only as a
 * hint — Tab can't type it.
 */
function guidance(editor: vscode.TextEditor, hunks: readonly Hunk[], session: Session | undefined): string | undefined {
  if (!vscode.workspace.getConfiguration('slipstream').get<boolean>('guidanceHints', true)) return undefined;
  if (!editor.selection.isEmpty) return undefined;
  const at = editor.selection.active;
  if (editor.document.lineAt(at.line).text.slice(at.character).trim()) return undefined;
  const changeLines = [...new Set(hunks.map((h) => editor.document.positionAt(h.start).line))];
  // Without a session (a single explicit target) there are no steps: only point at changes in this file.
  if (!session) return changeLines.length ? guidanceText({ changeLines, cursorLine: at.line, pending: [], mac: process.platform === 'darwin' }) : undefined;
  const root = session.link.practiceRoot;
  return guidanceText({
    changeLines,
    cursorLine: at.line,
    pending: session.pending,
    currentPath: path.relative(root, editor.document.uri.fsPath).split(path.sep).join('/'),
    folderMissing: (step) => !fs.existsSync(path.dirname(path.join(root, step.path))),
    mac: process.platform === 'darwin',
  });
}
