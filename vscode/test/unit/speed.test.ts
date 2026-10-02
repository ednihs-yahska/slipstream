import { describe, expect, it } from 'vitest';
import { charsToType, estimate, formatDuration, formatEstimate } from '../../src/stats/estimate';
import { classify, correctionRate, SpeedMeter, wpm } from '../../src/stats/speed';

const ins = (text: string, rangeLength = 0) => ({ text, rangeLength });

describe('classify: what counts as a keystroke', () => {
  it.each([
    ['a letter', [ins('a')], { keys: 1, chars: 1, corrections: 0 }],
    ['a space', [ins(' ')], { keys: 1, chars: 1, corrections: 0 }],
    ['an emoji (one key, two UTF-16 units)', [ins('😀')], { keys: 1, chars: 1, corrections: 0 }],
    ['typing over a selection', [ins('x', 5)], { keys: 1, chars: 1, corrections: 0 }],
    ['Enter with auto-indent', [ins('\n    ')], { keys: 1, chars: 1, corrections: 0 }],
    ['Enter between braces (two lines)', [ins('\n    \n')], { keys: 1, chars: 1, corrections: 0 }],
    ['CRLF Enter', [ins('\r\n\t')], { keys: 1, chars: 1, corrections: 0 }],
    ['an auto-closed pair', [ins('()')], { keys: 1, chars: 1, corrections: 0 }],
    ['Backspace', [ins('', 1)], { keys: 1, chars: 0, corrections: 1 }],
    ['deleting a word', [ins('', 6)], { keys: 1, chars: 0, corrections: 1 }],
    ['multi-cursor typing counts once', [ins('a'), ins('a'), ins('a')], { keys: 1, chars: 1, corrections: 0 }],
  ])('%s', (_, changes, expected) => {
    expect(classify(changes)).toEqual(expected);
  });

  it.each([
    ['a paste', [ins('const x = 1;\nconst y = 2;')]],
    ['a completion', [ins('toString')]],
    ['a snippet', [ins('for (let i = 0; i < n; i++) {\n\t\n}')]],
    ['indentation from the Tab key', [ins('    ')]],
    ['different edits at several places (a format)', [ins('a'), ins('b')]],
  ])('%s is not typing', (_, changes) => {
    expect(classify(changes)).toEqual({ keys: 0, chars: 0, corrections: 0 });
  });

  it('never counts a Tab/Shift+Tab accept, or undo/redo', () => {
    expect(classify([ins('x')], { accepted: true }).keys).toBe(0);
    expect(classify([ins('x')], { undoRedo: true }).keys).toBe(0);
  });
});

describe('SpeedMeter', () => {
  it('measures active time between keys, leaving idle gaps out', () => {
    let t = 0;
    const m = new SpeedMeter(undefined, 5_000, () => t);
    const key = { keys: 1, chars: 1, corrections: 0 };
    for (let i = 0; i < 50; i++) {
      t += 200; // 300 characters a minute
      m.record(key);
    }
    t += 60_000; // a minute away from the keyboard
    for (let i = 0; i < 50; i++) {
      t += 200;
      m.record(key);
    }
    // 100 keys, 99 counted gaps of 200 ms: the first key after the pause starts afresh.
    expect(m.totals).toEqual({ keys: 100, chars: 100, corrections: 0, activeMs: 98 * 200 });
    expect(m.average()).toBeCloseTo(100 / 5 / ((98 * 200) / 60_000), 5);
  });

  it('reports a current speed over the last minute', () => {
    let t = 0;
    const m = new SpeedMeter(undefined, 5_000, () => t);
    for (let i = 0; i < 100; i++) {
      t += 100; // fast
      m.record({ keys: 1, chars: 1, corrections: 0 });
    }
    t += 120_000;
    expect(m.current()).toBeUndefined(); // nothing in the last minute
    for (let i = 0; i < 100; i++) {
      t += 300; // slower now
      m.record({ keys: 1, chars: 1, corrections: 0 });
    }
    expect(m.current()).toBeCloseTo(40, 0); // 200 chars/min = 40 wpm
    expect(m.average()!).toBeGreaterThan(m.current()!);
  });

  it('says nothing about speed from too little typing', () => {
    expect(wpm(5, 60_000)).toBeUndefined();
    expect(wpm(100, 1_000)).toBeUndefined();
  });

  it('reports corrections as a share of keys once there are enough', () => {
    expect(correctionRate({ keys: 10, chars: 9, corrections: 1, activeMs: 1 })).toBeUndefined();
    expect(correctionRate({ keys: 100, chars: 94, corrections: 6, activeMs: 1 })).toBeCloseTo(0.06);
  });
});

describe('estimates', () => {
  it('counts characters to type, without indentation', () => {
    expect(charsToType('function f() {\n    return 1;\n}\n')).toBe(14 + 1 + 9 + 1 + 1 + 1);
    expect(charsToType('')).toBe(0);
  });

  it('takes the Tab-filled share out, and narrows with more data', () => {
    const plain = estimate(2000, { wpm: 40 }); // 200 cpm → 10 min
    expect(plain.ms).toBeCloseTo(10 * 60_000);
    const withTab = estimate(2000, { wpm: 40, tabShare: 0.5 });
    expect(withTab.ms).toBeLessThan(plain.ms * 0.6);
    expect(estimate(2000, { wpm: 40, measuredChars: 5000 }).highMs).toBeCloseTo(plain.ms * 1.1);
    expect(estimate(2000, {}).guess).toBe(true);
  });

  it('formats durations and ranges', () => {
    expect(formatDuration(12 * 60_000)).toBe('12 min');
    expect(formatDuration(80 * 60_000)).toBe('1 h 20 min');
    expect(formatEstimate(estimate(6000, { wpm: 40 }))).toBe('~24–36 min');
    expect(formatEstimate(estimate(6000, {}))).toBe('about 30 min');
    expect(formatEstimate(estimate(10, { wpm: 40 }))).toBe('under a minute');
    expect(formatEstimate(estimate(12000, { wpm: 40 }))).toBe('~48 min–1 h 12 min');
  });
});
