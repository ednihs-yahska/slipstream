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
import { leadingBreak, lineCol, needsRoom, Ghost } from './diff/tolerance';
import { planFor } from './order/commitOrder';
import { lf, pendingUnits, remaining, touches } from './order/units';
import { ghostAtCursor, ghostKey, GhostTextProvider } from './ghost/GhostTextProvider';
import { guidanceText } from './ghost/guidance';
import { hintFor } from './ghost/hint';
import { chooseMode, currentMode, Reveal } from './ghost/modes';
import { linkPracticeFolder, openPracticeFolder } from './practice/practice';
import { goToCommit, HistoryView, Mode, stepHistory, switchBranch } from './history/history';
import { newPractice, NewPracticeArgs } from './practice/newPractice';
import { clearLocalCheckout, clonePracticeRepo, pickLocalCheckout, storeProgress } from './practice/portable';
import { commitAndNext, replayCommit, replayContinue, replayNextCommit, replayRange } from './practice/replay';
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
  history: HistoryView;
}

export function activate(context: vscode.ExtensionContext): SlipstreamApi {
  context.subscriptions.push(initLog());
  const store = new TargetStore();
  const decorations = new Decorations();
  const sessions = new Sessions(context, store);
  const historyProvider = new HistoryView(sessions);
  const historyView = vscode.window.createTreeView('slipstream.history', { treeDataProvider: historyProvider });
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
    // Whole new lines before code on this line: move that code down first, so the new
    // lines are typed on a line of their own. The edit triggers another refresh.
    if (ghost && (await makeRoom(editor, ghost))) return;
    const session0 = sessions.sessionFor(editor.document.uri.fsPath);
    const mistake = ghost?.mistyped !== undefined ? `◂ "${ghost.mistyped}" isn't what's next · Backspace, or Tab to fix` : undefined;
    const hint = hidden
      ? (mistake ?? (mode === 'hint' ? hintFor(ghost!.text) : '◂ …'))
      : !ghost
        ? guidance(editor, hunks, session0)
        : undefined;
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
    if (ghost) {
      // In a practice file the next text is known: the autocomplete popup would cover the
      // ghost (and take Tab), so close it whenever a Slipstream ghost is at the cursor.
      await vscode.commands.executeCommand('hideSuggestWidget');
      // The popup opens a few milliseconds after a keystroke, which can be after this refresh.
      setTimeout(() => {
        if (seq === refreshSeq) void vscode.commands.executeCommand('hideSuggestWidget');
      }, 80);
    }
    if (ghost && !hidden) await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    if (hidden) await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
  };

  /** Insert a line break after the cursor, keeping the cursor where it is. Slipstream's edit, not typing. */
  let makingRoom = false;
  const makeRoom = async (editor: vscode.TextEditor, ghost: Ghost): Promise<boolean> => {
    if (makingRoom || !editor.selection.isEmpty) return false;
    const doc = editor.document;
    const pos = editor.selection.active;
    if (!needsRoom(doc.getText(), ghost, doc.offsetAt(pos))) return false;
    makingRoom = true;
    try {
      sessions.expectInternal(doc.uri);
      const ok = await editor.edit((b) => b.insert(pos, doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'));
      if (ok) editor.selection = new vscode.Selection(pos, pos);
      return ok;
    } finally {
      makingRoom = false;
    }
  };

  const accept = (pick: (ghost: string, textAfterCursor: string) => string, fallback: string) => async () => {
    const editor = vscode.window.activeTextEditor;
    let ghost = editor ? await ghostAtCursor(store, editor) : undefined;
    await vscode.commands.executeCommand('hideSuggestWidget');
    // Tab before the refresh has made room: make it now.
    if (editor && ghost && (await makeRoom(editor, ghost))) ghost = await ghostAtCursor(store, editor);
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
    if (direction === 1 && (await nextInCommitOrder())) return;
    const editor = vscode.window.activeTextEditor;
    const hunks = editor ? await store.getHunks(editor.document) : undefined;
    if (!editor || !hunks?.length) return;
    const target = pickHunk(hunks, editor.document.offsetAt(editor.selection.active), direction);
    await settleAt(editor, editor.document.positionAt(target.start));
  };

  /** Put the cursor at the start of a change, ready to type it. */
  const settleAt = async (editor: vscode.TextEditor, pos: vscode.Position) => {
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    // Make room now rather than in the refresh the cursor move triggers: someone
    // typing straight after the jump must already be on a line of their own.
    const ghost = await ghostAtCursor(store, editor);
    if (ghost) await makeRoom(editor, ghost);
    // A change that starts at the end of a line opens with a line break: take the cursor to its first line of code.
    const at = editor.document.offsetAt(editor.selection.active);
    const lead = ghost && leadingBreak(ghost, at);
    if (lead) {
      sessions.expectInternal(editor.document.uri); // the jump typed it, not you
      await editor.edit((b) => b.insert(editor.document.positionAt(at), lead), { undoStopBefore: true, undoStopAfter: false });
      const end = editor.document.positionAt(at + lead.length);
      editor.selection = new vscode.Selection(end, end);
    }
    await refresh();
  };

  /**
   * Alt+] while typing a commit: the next edit in dependency order, in any file.
   * Creates the file if it doesn't exist yet. False if there's no commit, no
   * plan, or nothing left in it, and Alt+] falls back to the next change in this file.
   */
  const nextInCommitOrder = async (): Promise<boolean> => {
    if (vscode.workspace.getConfiguration('slipstream').get<string>('editOrder', 'symbols') !== 'symbols') return false;
    const editor = vscode.window.activeTextEditor;
    const session = editor && sessions.sessionFor(editor.document.uri.fsPath);
    const pending = session && planFor(session.link);
    if (!session || !pending) return false;
    const plan = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Slipstream: working out the order of edits' }, () => pending);
    if (!plan) return false;
    const root = session.link.practiceRoot;
    const lenient = vscode.workspace.getConfiguration('slipstream').get<string>('whitespace', 'lenient') === 'lenient';
    const textOf = (rel: string) => {
      const abs = path.join(root, rel);
      const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === abs);
      if (open) return open.getText();
      try {
        return fs.readFileSync(abs, 'utf8');
      } catch {
        return undefined;
      }
    };
    const left = pendingUnits(plan.units, plan.after, textOf, lenient);
    const todo = plan.units.filter((u) => left.has(u.id));
    if (!todo.length) return false;

    // Already at the next edit: go on to the one after it.
    let next = todo[0];
    const rel = path.relative(root, editor.document.uri.fsPath).split(path.sep).join('/');
    if (next.rel === rel && todo.length > 1) {
      const real = lf(editor.document.getText());
      const cursor = lf(editor.document.getText(new vscode.Range(new vscode.Position(0, 0), editor.selection.active))).length;
      const here = remaining(real, plan.after.get(rel)!, lenient).find((l) => touches(next, l.range));
      if (here && cursor >= here.hunk.start && cursor <= Math.max(here.hunk.end, here.hunk.start + here.hunk.insert.length)) next = todo[1];
    }

    const abs = path.join(root, next.rel);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '');
    }
    const target = await vscode.window.showTextDocument(vscode.Uri.file(abs));
    const real = lf(target.document.getText());
    const spot = remaining(real, plan.after.get(next.rel)!, lenient).find((l) => touches(next, l.range));
    const { line, character } = lineCol(real, spot ? spot.hunk.start : 0);
    await settleAt(target, new vscode.Position(line, character));
    const names = plan.names.get(next.id);
    const step = plan.units.indexOf(next) + 1;
    vscode.window.setStatusBarMessage(`Slipstream: edit ${step}/${plan.units.length}${names?.length ? `: ${names.slice(0, 3).join(', ')}` : ''} in ${next.rel}`, 5000);
    return true;
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
    vscode.commands.registerCommand('slipstream.newPractice', (args?: NewPracticeArgs) => newPractice(context, store, args)),
    // The old command id still works: it's the same flow now (practice folders are always separate).
    vscode.commands.registerCommand('slipstream.startPractice', (args?: NewPracticeArgs) => newPractice(context, store, args)),
    historyView,
    vscode.commands.registerCommand('slipstream.goToCommit', (root?: string, target?: string, mode?: Mode) => {
      const r = root ?? historyProvider.current()?.link.practiceRoot;
      return r && target ? goToCommit(store, sessions, r, target, mode) : false;
    }),
    vscode.commands.registerCommand('slipstream.olderCommit', (mode?: Mode) => stepHistory(store, sessions, historyProvider, 'older', mode)),
    vscode.commands.registerCommand('slipstream.newerCommit', (mode?: Mode) => stepHistory(store, sessions, historyProvider, 'newer', mode)),
    vscode.commands.registerCommand('slipstream.history.refresh', () => historyProvider.refresh()),
    vscode.commands.registerCommand('slipstream.switchBranch', (root?: string, branch?: string) => {
      const r = typeof root === 'string' ? root : historyProvider.current()?.link.practiceRoot;
      if (!r) {
        void vscode.window.showInformationMessage('Open a practice folder first.');
        return false;
      }
      return switchBranch(store, sessions, r, branch);
    }),
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
    vscode.commands.registerCommand('slipstream.commitAndNext', (arg?: string | Node, how?: 'original' | 'edit' | 'skip') => {
      const session = replaySession(arg);
      return commitAndNext(store, session?.link.practiceRoot ?? rootOf(arg), how ?? 'original', session?.pending.length ?? 0);
    }),
    vscode.commands.registerCommand('slipstream.commitEditedAndNext', (arg?: string | Node) => {
      const session = replaySession(arg);
      return commitAndNext(store, session?.link.practiceRoot ?? rootOf(arg), 'edit', session?.pending.length ?? 0);
    }),
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
  return { store, sessions, ghost: ghostProvider, hint: () => lastHint, history: historyProvider };
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
