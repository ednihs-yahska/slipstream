import { formatDuration, formatEstimate } from './estimate';
import type { Pace, Session } from '../steps/Sessions';

/** "42 wpm", or undefined when there isn't enough typing to say. */
export function speedText(p: Pace): string | undefined {
  const v = p.current ?? p.average;
  return v === undefined ? undefined : `${Math.round(v)} wpm`;
}

/** "~12 min left", "about 30 min left" (no data yet), or "" when nothing is left. */
export function leftText(p: Pace): string {
  return p.charsLeft > 0 ? `${formatEstimate(p.session)} left` : '';
}

/** Tooltip lines for a session. */
export function paceLines(p: Pace): string[] {
  const w = (v: number | undefined) => (v === undefined ? '—' : `${Math.round(v)} wpm`);
  const lines = [
    `Speed:    now ${w(p.current)} · this session ${w(p.average)} · you overall ${w(p.personal)}`,
    ...(p.corrections !== undefined ? [`Accuracy: ${Math.round(p.corrections * 100)}% of keys were corrections`] : []),
    `Typed:    ${formatDuration(p.spentMs)} of active typing so far`,
  ];
  if (p.charsLeft > 0 || p.projectCharsLeft > 0) {
    lines.push(`Left:     ${p.charsLeft.toLocaleString()} characters, ${formatEstimate(p.session)}${p.session.guess ? ' (a guess: no typing measured yet)' : ''}`);
  }
  if (p.projectCharsLeft > p.charsLeft) {
    lines.push(`Project:  ${p.projectCharsLeft.toLocaleString()} characters across the rest of the replay, ${formatEstimate(p.project)}`);
  }
  return lines;
}

/** The Show Practice Stats report, as Markdown. */
export function statsMarkdown(sessions: Session[]): string {
  const out = ['# Slipstream practice stats', ''];
  if (sessions.length === 0) return out.concat('No practice folders in this window.').join('\n');
  const byProject = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = s.link.remote?.url ?? s.link.targetRoot;
    byProject.set(key, [...(byProject.get(key) ?? []), s]);
  }
  for (const [project, group] of byProject) {
    out.push(`## ${project}`, '');
    out.push('| Practice folder | Speed (now / session) | Accuracy | Typed so far | Left | Time left |', '|---|---|---|---|---|---|');
    let spent = 0;
    let chars = 0;
    for (const s of group) {
      const p = s.pace;
      spent += p.spentMs;
      chars += p.projectCharsLeft;
      const w = (v: number | undefined) => (v === undefined ? '—' : `${Math.round(v)}`);
      out.push(
        `| ${s.link.practiceRoot} | ${w(p.current)} / ${w(p.average)} wpm | ${p.corrections === undefined ? '—' : `${Math.round(p.corrections * 100)}% corrections`} | ${formatDuration(p.spentMs)} | ${p.projectCharsLeft.toLocaleString()} chars | ${p.projectCharsLeft ? formatEstimate(p.project) : 'done'} |`,
      );
    }
    const any = group[0].pace;
    out.push('', `**Whole project:** ${formatDuration(spent)} typed so far, ${chars.toLocaleString()} characters left${chars ? `, ${formatEstimate({ ...any.project, ms: sum(group, 'ms'), lowMs: sum(group, 'lowMs'), highMs: sum(group, 'highMs') })}` : ''}.`, '');
  }
  out.push(
    '---',
    'Speed counts real keystrokes only: not Tab/Shift+Tab, undo/redo, pastes or completions. Active time leaves out pauses longer than `slipstream.idleSeconds`. Estimates take out the share you usually Tab-fill, and use your overall speed until a session has enough typing of its own.',
  );
  return out.join('\n');
}

function sum(group: Session[], k: 'ms' | 'lowMs' | 'highMs'): number {
  return group.reduce((n, s) => n + s.pace.project[k], 0);
}
