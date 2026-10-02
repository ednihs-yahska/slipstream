import * as vscode from 'vscode';

/**
 * How much the ghost gives away:
 *   ghost   — the code, right away (default)
 *   delayed — nothing until you've been stuck at the spot for a few seconds
 *   hint    — never the code: a nudge (lines, first word, names it defines)
 * In every mode, Tab / Shift+Tab still fill in a word / line: a peek.
 */
export type Mode = 'ghost' | 'delayed' | 'hint';

export function currentMode(): Mode {
  return vscode.workspace.getConfiguration('slipstream').get<Mode>('mode', 'ghost');
}

/** Delayed mode: when you arrived at the current spot, and a timer to reveal it. */
export class Reveal implements vscode.Disposable {
  private key?: string;
  private arrived = 0;
  private timer?: NodeJS.Timeout;

  constructor(private readonly onReveal: () => void) {}

  /** Call on every refresh with where the ghost is (undefined: no ghost). Typing a correct character moves the spot and restarts the clock. */
  at(key: string | undefined) {
    if (key === this.key) return;
    this.key = key;
    this.arrived = Date.now();
    clearTimeout(this.timer);
    if (key && currentMode() === 'delayed') this.timer = setTimeout(this.onReveal, delayMs() + 20);
  }

  revealed(key: string): boolean {
    return key === this.key && Date.now() - this.arrived >= delayMs();
  }

  dispose() {
    clearTimeout(this.timer);
  }
}

function delayMs(): number {
  return 1000 * vscode.workspace.getConfiguration('slipstream').get<number>('revealDelaySeconds', 3);
}

export async function chooseMode() {
  const items: (vscode.QuickPickItem & { mode: Mode })[] = [
    { label: '$(eye) Ghost', description: 'default', detail: 'Show the code still to type, right away.', mode: 'ghost' },
    { label: '$(watch) Delayed', detail: 'Try to recall it first: the code appears after a few seconds stuck at the spot (slipstream.revealDelaySeconds).', mode: 'delayed' },
    { label: '$(lightbulb) Hint', detail: 'Never show the code: a nudge instead (lines, first word, names it defines).', mode: 'hint' },
  ];
  const now = currentMode();
  const pick = await vscode.window.showQuickPick(
    items.map((i) => ({ ...i, picked: i.mode === now, label: i.mode === now ? `${i.label} (current)` : i.label })),
    { title: 'Slipstream: practice mode. Tab still peeks a word in every mode.' },
  );
  if (pick) await vscode.workspace.getConfiguration('slipstream').update('mode', pick.mode, vscode.ConfigurationTarget.Global);
}
