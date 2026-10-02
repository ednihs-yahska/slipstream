import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../log';
import { subjectOf } from '../practice/git';
import { moreAfter } from '../practice/replay';
import { KNOWN_KEY } from '../practice/practice';
import { clearLinkCache, isInside, Link, LINK_FILE, readLink } from '../target/links';
import { ensureClone, fetchRemote, isCloned } from '../target/remotes';
import { TargetStore } from '../target/TargetStore';
import { addedLines } from '../practice/git';
import { charsToType, estimate, Estimate, formatEstimate } from '../stats/estimate';
import { classify, correctionRate, SpeedMeter, wpm } from '../stats/speed';
import { applyPlan, Plan, readPlan } from './plan';
import { createProgressFile, progressKey, readProgress, StoredProgress, writeProgress } from './progress';
import { toKey } from './scan';
import { computeSteps, modifyStepFor, sortSteps, Step, StepInput, stepKey } from './StepModel';

/** How the current session's code got into the practice folder. */
export interface Stats {
  /** Non-whitespace characters you typed yourself. */
  typed: number;
  /** Non-whitespace characters Tab / Shift+Tab filled in. */
  accepted: number;
  startedAt: number;
  /** Real keystrokes (see stats/speed.ts), characters they produced, Backspace/Delete, and active typing time. */
  keys?: number;
  chars?: number;
  corrections?: number;
  activeMs?: number;
}

/** Speed and time left, for display. */
export interface Pace {
  /** Words per minute over the last minute of typing, this session's average, and yours across sessions. */
  current?: number;
  average?: number;
  personal?: number;
  /** Corrections as a share of keystrokes. */
  corrections?: number;
  /** Characters left to type in this session, and in the rest of the project (later replay commits included). */
  charsLeft: number;
  projectCharsLeft: number;
  session: Estimate;
  project: Estimate;
  /** Active typing time spent in this session so far. */
  spentMs: number;
}

/** Your typing across all sessions and projects (global state, never committed). */
interface Profile {
  chars: number;
  activeMs: number;
  typed: number;
  accepted: number;
}

/** One practice folder and its steps. */
export interface Session {
  link: Link;
  /** Commit subject, for a replay. */
  subject?: string;
  /** The agent's plan (`.slipstream/plan.md` in the project), if any. */
  plan?: Plan;
  stats: Stats;
  pace: Pace;
  /** Steps still to do. */
  pending: Step[];
  /** Steps done: seen at some point, no longer pending. */
  done: Step[];
  scanned: boolean;
}

interface State {
  link: Link;
  subject?: string;
  plan?: Plan;
  stats: Stats;
  meter: SpeedMeter;
  /** Characters in the replay's later commits (computed once per commit). */
  laterChars: number;
  pending: Step[];
  /** Every step ever seen in this session, by key (persisted). */
  seen: Record<string, Step>;
  scanned: boolean;
  completeNotified: boolean;
  watchers: vscode.Disposable[];
  timer?: NodeJS.Timeout;
}

const SKIP_EVENT = /[\\/](\.git|node_modules)[\\/]/;

/** A session is a practice folder + its target (+ commit): a new commit is a new session. */
const identity = (l: Link) => `${l.practiceRoot}|${l.source === 'remote' ? l.remote!.url : l.targetRoot}|${l.refLabel ?? ''}`;

/**
 * Finds the practice folders relevant to this window and keeps their steps
 * up to date as you type, create and delete files, and as the agent works.
 */
export class Sessions implements vscode.Disposable {
  private readonly states = new Map<string, State>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  private discoverTimer?: NodeJS.Timeout;
  private readonly typingTimers = new Map<string, NodeJS.Timeout>();
  private readonly expected = new Map<string, string>();
  private readonly internal = new Set<string>();

  readonly onDidChange = this.emitter.event;

  private fetchTimer?: NodeJS.Timeout;
  private readonly cloneFailures = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: TargetStore,
  ) {
    const links = vscode.workspace.createFileSystemWatcher(`**/${LINK_FILE.split(path.sep).join('/')}`);
    const rediscover = () => this.scheduleDiscover();
    this.disposables.push(
      links,
      links.onDidCreate(rediscover),
      links.onDidChange(rediscover),
      links.onDidDelete(rediscover),
      vscode.workspace.onDidChangeWorkspaceFolders(rediscover),
      // Start/Link Practice and link edits invalidate the store.
      store.onDidChangeTargets(rediscover),
      vscode.workspace.onDidChangeTextDocument((e) => this.onType(e)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('slipstream.remoteFetchMinutes')) this.scheduleFetch();
        if (e.affectsConfiguration('slipstream.whitespace') || e.affectsConfiguration('slipstream.stepOrder')) for (const s of this.states.values()) this.schedule(s, 0);
      }),
    );
    void this.discover();
    this.scheduleFetch();
  }

  /** Fetch every remote target and rescan its sessions. */
  async fetchRemotes(): Promise<number> {
    const remotes = [...this.states.values()].filter((s) => s.link.source === 'remote' && s.link.remote);
    for (const s of remotes) {
      try {
        await fetchRemote(s.link.remote!);
        log.info(`Fetched ${s.link.remote!.url}`);
      } catch (e) {
        log.error(`Fetching ${s.link.remote!.url} failed`, e);
      }
    }
    if (remotes.length) {
      clearLinkCache();
      this.store.invalidate();
      await Promise.all(remotes.map((s) => this.rescan(s)));
    }
    return remotes.length;
  }

  /** Opt this session's practice folder into storing progress in .slipstream/progress.json. */
  async storeProgressInFolder(practiceRoot: string) {
    const s = this.states.get(practiceRoot);
    if (!s) return;
    createProgressFile(practiceRoot, progressKey(s.link.refLabel), { seen: s.seen, stats: s.stats });
  }

  private scheduleFetch() {
    clearInterval(this.fetchTimer);
    const minutes = vscode.workspace.getConfiguration('slipstream').get<number>('remoteFetchMinutes', 10);
    if (minutes > 0) this.fetchTimer = setInterval(() => void this.fetchRemotes(), minutes * 60_000);
  }

  list(): Session[] {
    return [...this.states.values()].map((s) => this.view(s));
  }

  /** The session whose practice folder contains `fsPath` (innermost first). */
  sessionFor(fsPath: string): Session | undefined {
    const matches = [...this.states.values()].filter((s) => isInside(fsPath, s.link.practiceRoot));
    matches.sort((a, b) => b.link.practiceRoot.length - a.link.practiceRoot.length);
    return matches[0] && this.view(matches[0]);
  }

  async refresh() {
    await this.discover();
    await Promise.all([...this.states.values()].map((s) => this.rescan(s)));
  }

  async resetProgress(practiceRoot: string) {
    const s = this.states.get(practiceRoot);
    if (!s) return;
    s.seen = {};
    s.stats = { typed: 0, accepted: 0, startedAt: Date.now() };
    s.completeNotified = false;
    await this.rescan(s);
  }

  /** The next edit to `uri` inserting exactly `text` is Slipstream accepting a ghost, not you typing. */
  expectAccepted(uri: vscode.Uri, text: string) {
    this.expected.set(uri.toString(), text);
  }

  /** The next edit to `uri` is Slipstream's own (e.g. Delete Marked): neither typing nor a correction. */
  expectInternal(uri: vscode.Uri) {
    this.internal.add(uri.toString());
  }

  /** Wait for any pending scan (used by tests and commands that need fresh steps). */
  async settle() {
    for (const s of this.states.values()) {
      if (s.timer) {
        clearTimeout(s.timer);
        s.timer = undefined;
        await this.rescan(s);
      }
    }
  }

  private view(s: State): Session {
    const pendingKeys = new Set(s.pending.map(stepKey));
    const done = sortSteps(Object.entries(s.seen).filter(([k]) => !pendingKeys.has(k)).map(([, step]) => step));
    return { link: s.link, subject: s.subject, plan: s.plan, stats: s.stats, pace: this.pace(s), pending: s.pending, done, scanned: s.scanned };
  }

  private scheduleDiscover() {
    clearTimeout(this.discoverTimer);
    this.discoverTimer = setTimeout(() => void this.discover(), 300);
  }

  private async discover() {
    const links = new Map<string, Link>();
    const add = (l: Link | undefined) => l && links.set(l.practiceRoot, l);
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) add(readLink(f.uri.fsPath));
    log.debug(`Looking for practice folders`);
    for (const uri of await vscode.workspace.findFiles(`**/${LINK_FILE.split(path.sep).join('/')}`, '**/node_modules/**', 50)) {
      add(readLink(path.dirname(path.dirname(uri.fsPath))));
    }
    // Practice folders elsewhere on disk whose project is open here.
    for (const p of this.context.globalState.get<string[]>(KNOWN_KEY, [])) {
      const l = readLink(p);
      if (l && folders.some((f) => isInside(l.targetRoot, f.uri.fsPath) || isInside(l.practiceRoot, f.uri.fsPath))) add(l);
    }

    let changed = false;
    for (const [root, s] of this.states) {
      const l = links.get(root);
      if (!l || identity(l) !== identity(s.link)) {
        s.watchers.forEach((w) => w.dispose());
        clearTimeout(s.timer);
        this.states.delete(root);
        changed = true;
      }
    }
    for (const link of links.values()) {
      if (this.states.has(link.practiceRoot)) continue;
      // Progress stored in the practice folder (if it opted in) wins over this machine's.
      const stored = readProgress(link.practiceRoot, progressKey(link.refLabel));
      const statsNow = stored?.stats ?? this.context.workspaceState.get<Stats>(statsKey(link));
      const s: State = {
        link,
        meter: new SpeedMeter(
          { keys: statsNow?.keys ?? 0, chars: statsNow?.chars ?? 0, corrections: statsNow?.corrections ?? 0, activeMs: statsNow?.activeMs ?? 0 },
          1000 * vscode.workspace.getConfiguration('slipstream').get<number>('idleSeconds', 5),
        ),
        laterChars: 0,
        stats: stored?.stats ?? this.context.workspaceState.get<Stats>(statsKey(link)) ?? { typed: 0, accepted: 0, startedAt: Date.now() },
        pending: [],
        seen: stored?.seen ?? this.context.workspaceState.get<Record<string, Step>>(seenKey(link), {}),
        scanned: false,
        completeNotified: false,
        watchers: [],
      };
      // A commit never changes: only the practice folder needs watching.
      s.watchers = link.ref ? [this.watch(s, link.practiceRoot)] : [this.watch(s, link.practiceRoot), this.watch(s, link.targetRoot)];
      this.states.set(link.practiceRoot, s);
      changed = true;
      if (link.pinned && link.ref) {
        void subjectOf(link.targetRoot, link.ref).then(
          (subject) => {
            s.subject = subject;
            this.emitter.fire();
          },
          () => undefined,
        );
      }
      // An already-cloned remote may have moved since this machine last looked.
      if (link.source === 'remote' && link.remote && isCloned(link.targetRoot)) {
        void fetchRemote(link.remote).then(
          () => {
            clearLinkCache();
            this.store.invalidate();
            return this.rescan(s);
          },
          (e) => log.warn(`Fetching ${link.remote!.url} failed; using the cached copy (${(e as Error).message.split('\n')[0]})`),
        );
      }
      void this.rescan(s);
    }
    if (changed) this.emitter.fire();
  }

  private watch(s: State, root: string): vscode.Disposable {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**/*'));
    const on = (uri: vscode.Uri) => {
      if (!SKIP_EVENT.test(uri.fsPath)) this.schedule(s, 400);
    };
    w.onDidCreate(on);
    w.onDidDelete(on);
    w.onDidChange(on);
    return w;
  }

  private schedule(s: State, ms: number) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = undefined;
      void this.rescan(s);
    }, ms);
  }

  private input(s: State): StepInput {
    const unsaved = new Map<string, string>();
    for (const d of vscode.workspace.textDocuments) {
      if (d.isDirty && d.uri.scheme === 'file' && isInside(d.uri.fsPath, s.link.practiceRoot)) {
        unsaved.set(toKey(path.relative(s.link.practiceRoot, d.uri.fsPath)), d.getText());
      }
    }
    const lenient = vscode.workspace.getConfiguration('slipstream').get<string>('whitespace', 'lenient') === 'lenient';
    const order = vscode.workspace.getConfiguration('slipstream').get<'dependencies' | 'path'>('stepOrder', 'dependencies');
    return { practiceRoot: s.link.practiceRoot, targetRoot: s.link.targetRoot, targetRef: s.link.ref, lenientWhitespace: lenient, order, unsaved };
  }

  private async rescan(s: State) {
    // The link may have changed underneath (a fetch moved a branch, an override appeared).
    const fresh = readLink(s.link.practiceRoot);
    if (fresh && identity(fresh) === identity(s.link)) s.link = fresh;
    if (s.link.source === 'remote' && !isCloned(s.link.targetRoot)) {
      if (!(await this.cloneRemote(s))) return;
    }
    const started = Date.now();
    try {
      // A replay's target is a commit: the plan belongs to live agent work only.
      s.plan = s.link.ref ? undefined : readPlan(s.link.targetRoot);
      s.pending = applyPlan(await computeSteps(this.input(s)), s.plan);
    } catch (e) {
      log.error(`Scanning ${s.link.practiceRoot} against ${s.link.targetRoot} failed`, e);
      return;
    }
    log.debug(`Scanned ${s.link.practiceRoot} in ${Date.now() - started} ms: ${s.pending.length} steps left`);
    await this.computeLaterChars(s);
    s.scanned = true;
    await this.record(s);
  }

  /** While typing, only the edited file's change count can move: recompute just that. */
  private onType(e: vscode.TextDocumentChangeEvent) {
    const doc = e.document;
    if (doc.uri.scheme !== 'file') return;
    const s = [...this.states.values()].find((x) => isInside(doc.uri.fsPath, x.link.practiceRoot));
    if (!s) return;
    this.count(s, doc.uri, e);
    if (!s.scanned) return;
    const rel = toKey(path.relative(s.link.practiceRoot, doc.uri.fsPath));
    const existing = s.pending.find((p) => p.path === rel && p.kind !== 'rename');
    if (existing && existing.kind !== 'modify') return;
    clearTimeout(this.typingTimers.get(rel));
    this.typingTimers.set(
      rel,
      setTimeout(async () => {
        const step = await modifyStepFor(this.input(s), rel);
        // Keep the step where it is (plan or dependency order); just update or drop it.
        const at = s.pending.findIndex((p) => p.path === rel && p.kind === 'modify');
        const next = [...s.pending];
        if (at >= 0) {
          if (step) next[at] = { ...step, reason: next[at].reason };
          else next.splice(at, 1);
        } else if (step) {
          next.push(step);
        }
        s.pending = next;
        await this.record(s);
      }, 250),
    );
  }

  private count(s: State, uri: vscode.Uri, e: vscode.TextDocumentChangeEvent) {
    const key = uri.toString();
    if (this.internal.delete(key)) return;
    const expected = this.expected.get(key);
    const accepted = expected !== undefined && e.contentChanges.some((c) => c.text === expected);
    // Who produced the code: typed versus Tab-filled characters (pastes count as typed here).
    for (const c of e.contentChanges) {
      const chars = c.text.replace(/\s+/g, '').length;
      if (!chars) continue;
      if (accepted && c.text === expected) {
        s.stats.accepted += chars;
        this.expected.delete(key);
      } else {
        s.stats.typed += chars;
      }
    }
    // How fast: real keystrokes only.
    const k = classify(e.contentChanges, { accepted, undoRedo: e.reason !== undefined });
    const before = s.meter.totals;
    s.meter.record(k);
    const after = s.meter.totals;
    s.stats = { ...s.stats, ...after };
    this.addToProfile({
      chars: after.chars - before.chars,
      activeMs: after.activeMs - before.activeMs,
      typed: 0,
      accepted: 0,
    });
    void this.context.workspaceState.update(statsKey(s.link), s.stats);
    if (k.keys) this.paceChanged();
  }

  private paceTimer?: NodeJS.Timeout;
  /** Speed changes with every key; refresh the display at most a few times a second. */
  private paceChanged() {
    if (this.paceTimer) return;
    this.paceTimer = setTimeout(() => {
      this.paceTimer = undefined;
      this.emitter.fire();
    }, 300);
  }

  private profile(): Profile {
    return this.context.globalState.get<Profile>(PROFILE_KEY) ?? { chars: 0, activeMs: 0, typed: 0, accepted: 0 };
  }

  private addToProfile(d: Profile) {
    if (!d.chars && !d.activeMs && !d.typed && !d.accepted) return;
    const p = this.profile();
    void this.context.globalState.update(PROFILE_KEY, {
      chars: p.chars + d.chars,
      activeMs: p.activeMs + d.activeMs,
      typed: p.typed + d.typed,
      accepted: p.accepted + d.accepted,
    });
  }

  /** Speed, accuracy and time left for one session, from its own data where there's enough, else yours overall. */
  private pace(s: State): Pace {
    const profile = this.profile();
    const average = s.meter.average();
    const personal = wpm(profile.chars, profile.activeMs);
    const enough = (s.stats.chars ?? 0) >= 200;
    const speed = enough ? average : (personal ?? average);
    const measuredChars = enough ? (s.stats.chars ?? 0) : profile.chars;
    const own = s.stats.typed + s.stats.accepted;
    const all = profile.typed + profile.accepted;
    const tabShare = own >= 200 ? s.stats.accepted / own : all >= 200 ? profile.accepted / all : 0;
    const charsLeft = s.pending.reduce((n, p) => n + (p.charsLeft ?? 0), 0);
    const projectCharsLeft = charsLeft + s.laterChars;
    return {
      current: s.meter.current(),
      average,
      personal,
      corrections: correctionRate(s.meter.totals),
      charsLeft,
      projectCharsLeft,
      session: estimate(charsLeft, { wpm: speed, tabShare, measuredChars }),
      project: estimate(projectCharsLeft, { wpm: speed, tabShare, measuredChars }),
      spentMs: s.stats.activeMs ?? 0,
    };
  }

  /** Characters in a replay's commits after the current one: the rest of "the whole project". */
  private async computeLaterChars(s: State) {
    const r = s.link.replay;
    if (!s.link.pinned || !r) {
      s.laterChars = 0;
      return;
    }
    let total = 0;
    for (const commit of r.commits.slice(r.index + 1)) {
      try {
        total += charsToType((await addedLines(s.link.targetRoot, commit)).join('\n'));
      } catch (e) {
        log.warn(`Could not size commit ${commit.slice(0, 7)}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
    s.laterChars = total;
  }

  /** First use of a remote target: clone it into the cache, then re-resolve the link. */
  private async cloneRemote(s: State): Promise<boolean> {
    const url = s.link.remote!.url;
    try {
      log.info(`Cloning ${url} into the remote cache`);
      await ensureClone(s.link.remote!);
    } catch (e) {
      log.error(`Cloning ${url} failed`, e);
      if (!this.cloneFailures.has(url)) {
        this.cloneFailures.add(url);
        void vscode.window.showWarningMessage(
          `Slipstream couldn't fetch ${url}: ${(e as Error).message.split('\n')[0]}. Point this machine at a local checkout instead?`,
          'Pick Local Checkout…',
        ).then((c) => c && vscode.commands.executeCommand('slipstream.pickLocalCheckout', s.link.practiceRoot));
      }
      return false;
    }
    clearLinkCache();
    s.link = readLink(s.link.practiceRoot) ?? s.link;
    this.store.invalidate();
    return true;
  }

  private persist(s: State) {
    const stored: StoredProgress = { seen: s.seen, stats: s.stats };
    writeProgress(s.link.practiceRoot, progressKey(s.link.refLabel), stored);
  }

  private async record(s: State) {
    for (const step of s.pending) s.seen[stepKey(step)] = step;
    await this.context.workspaceState.update(seenKey(s.link), s.seen);
    this.persist(s);
    this.emitter.fire();
    if (s.pending.length === 0 && Object.keys(s.seen).length > 0 && !s.completeNotified) {
      s.completeNotified = true;
      void this.announceComplete(s);
    }
    if (s.pending.length > 0) s.completeNotified = false;
  }

  private async announceComplete(s: State) {
    const what = s.link.pinned && s.link.ref
      ? `Commit ${s.link.ref.slice(0, 7)}${s.subject ? ` "${s.subject}"` : ''} done`
      : `Practice complete: ${path.basename(s.link.practiceRoot)} matches ${path.basename(s.link.targetRoot)}`;
    const replay = s.link.replay;
    const hasNext = !!replay && replay.index + 1 < replay.commits.length;
    // At the end of a replay, there may be more to type: later commits and uncommitted work.
    const canContinue = !!s.link.pinned && !hasNext && (await moreAfter(s.link));
    const actions = [...(hasNext ? ['Next Commit'] : []), ...(canContinue ? ['Continue to Current Files'] : [])];
    const pace = this.pace(s);
    const left = s.laterChars > 0 ? ` ~${formatDurationLeft(pace.project)} left in this replay.` : '';
    const choice = await vscode.window.showInformationMessage(`${what}. ${summarize(s.stats)}${left}`, ...actions);
    if (choice === 'Next Commit') await vscode.commands.executeCommand('slipstream.replayNextCommit', s.link.practiceRoot);
    if (choice === 'Continue to Current Files') await vscode.commands.executeCommand('slipstream.replayContinue', s.link.practiceRoot);
  }

  dispose() {
    clearInterval(this.fetchTimer);
    clearTimeout(this.paceTimer);
    for (const s of this.states.values()) {
      s.watchers.forEach((w) => w.dispose());
      clearTimeout(s.timer);
    }
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}

function seenKey(link: Link): string {
  return `slipstream.steps:${identity(link)}`;
}

function statsKey(link: Link): string {
  return `slipstream.stats:${identity(link)}`;
}

const PROFILE_KEY = 'slipstream.typingProfile';

function formatDurationLeft(e: Estimate): string {
  return formatEstimate(e).replace(/^~/, '');
}

/** "Took 12 min. You typed 78% yourself at 38 wpm, 6% corrections; Tab filled 22%." */
export function summarize(stats: Stats): string {
  const mins = Math.max(1, Math.round((Date.now() - stats.startedAt) / 60000));
  const total = stats.typed + stats.accepted;
  if (total === 0) return `Took ${mins} min.`;
  const typed = Math.round((100 * stats.typed) / total);
  const speed = wpm(stats.chars ?? 0, stats.activeMs ?? 0);
  const corr = correctionRate({ keys: stats.keys ?? 0, chars: stats.chars ?? 0, corrections: stats.corrections ?? 0, activeMs: stats.activeMs ?? 0 });
  const how = [
    ...(speed !== undefined ? [`at ${Math.round(speed)} wpm`] : []),
    ...(corr !== undefined ? [`${Math.round(corr * 100)}% corrections`] : []),
  ].join(', ');
  return `Took ${mins} min. You typed ${typed}% yourself${how ? ` ${how}` : ''}; Tab filled ${100 - typed}%.`;
}
