import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { addedLines } from '../../src/practice/git';
import { estimate } from '../../src/stats/estimate';
import { leftText, speedText, statsMarkdown } from '../../src/stats/report';
import type { Pace, Session } from '../../src/steps/Sessions';
import { computeSteps } from '../../src/steps/StepModel';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-m7-')));

describe('characters left per step', () => {
  it('counts what is still to type, without indentation', async () => {
    const proj = tmp();
    const practice = tmp();
    fs.writeFileSync(path.join(proj, 'new.ts'), 'function f() {\n    return 1;\n}\n');
    fs.writeFileSync(path.join(proj, 'edit.ts'), 'a();\nb();\n');
    fs.writeFileSync(path.join(practice, 'edit.ts'), 'a();\n');
    const steps = await computeSteps({ practiceRoot: practice, targetRoot: proj, lenientWhitespace: true });
    const by = Object.fromEntries(steps.map((s) => [s.path, s.charsLeft]));
    expect(by['new.ts']).toBe(14 + 1 + 9 + 1 + 1 + 1);
    expect(by['edit.ts']).toBe(5); // "b();" plus its line break
  });
});

describe('lines a commit added', () => {
  it('reads them from git, root commits included, inside the project folder only', async () => {
    const repo = tmp();
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString().trim();
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    fs.mkdirSync(path.join(repo, 'app'));
    fs.writeFileSync(path.join(repo, 'app/a.ts'), 'one\n');
    fs.writeFileSync(path.join(repo, 'outside.txt'), 'nope\n');
    git('add', '-A');
    git('commit', '-qm', 'root');
    const root = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'app/a.ts'), 'one\n  two\nthree\n');
    git('add', '-A');
    git('commit', '-qm', 'more');
    expect(await addedLines(path.join(repo, 'app'), root)).toEqual(['one']);
    expect(await addedLines(path.join(repo, 'app'), git('rev-parse', 'HEAD'))).toEqual(['  two', 'three']);
  });
});

describe('the report', () => {
  const pace = (over: Partial<Pace> = {}): Pace => ({
    current: 44.6,
    average: 38,
    personal: 40,
    corrections: 0.06,
    charsLeft: 2000,
    projectCharsLeft: 6000,
    session: estimate(2000, { wpm: 38, measuredChars: 2000 }),
    project: estimate(6000, { wpm: 38, measuredChars: 2000 }),
    spentMs: 25 * 60_000,
    ...over,
  });
  const session = (root: string, p: Pace) =>
    ({ link: { practiceRoot: root, targetRoot: '/proj', source: 'path' }, pace: p }) as unknown as Session;

  it('shows current speed, falling back to the session average', () => {
    expect(speedText(pace())).toBe('45 wpm');
    expect(speedText(pace({ current: undefined }))).toBe('38 wpm');
    expect(speedText(pace({ current: undefined, average: undefined }))).toBeUndefined();
    expect(leftText(pace())).toMatch(/^~\d+–\d+ min left$/);
    expect(leftText(pace({ charsLeft: 0 }))).toBe('');
  });

  it('groups practice folders by project, with a whole-project total', () => {
    const md = statsMarkdown([session('/proj/.slipstream/practice', pace()), session('/elsewhere/p', pace({ projectCharsLeft: 1000 }))]);
    expect(md).toContain('## /proj');
    expect(md).toContain('45 / 38 wpm');
    expect(md).toContain('6% corrections');
    expect(md).toMatch(/\*\*Whole project:\*\* 50 min typed so far, 7,000 characters left, ~/);
    expect(md).toContain('not Tab/Shift+Tab');
  });
});
