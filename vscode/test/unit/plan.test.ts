import { describe, expect, it } from 'vitest';
import { applyPlan, parsePlan } from '../../src/steps/plan';
import { Step } from '../../src/steps/StepModel';

describe('parsePlan', () => {
  it('reads a title and ordered entries with reasons', () => {
    const plan = parsePlan(`# Plan: Add greeting options

Some intro text mentioning \`src/ignored.ts\` outside a list.

1. \`src/types.ts\` — add \`GreetOptions\`, used by \`greet()\`
2. \`./src/greet.ts\`: accept options
- Delete \`src/legacy.ts\` (replaced by the options)
- [x] \`docs/README.md\` - **document** it
* \`notapath\` — skipped: no dot or slash
`);
    expect(plan.title).toBe('Add greeting options');
    expect(plan.entries).toEqual([
      { path: 'src/types.ts', reason: 'add `GreetOptions`, used by `greet()`' },
      { path: 'src/greet.ts', reason: 'accept options' },
      { path: 'src/legacy.ts', reason: 'Delete replaced by the options' },
      { path: 'docs/README.md', reason: 'document it' },
    ]);
  });

  it('merges repeated paths, keeping the first position', () => {
    const plan = parsePlan('1. `a.ts` — first\n2. `b.ts`\n3. `a.ts` — again\n');
    expect(plan.entries).toEqual([
      { path: 'a.ts', reason: 'first; again' },
      { path: 'b.ts', reason: undefined },
    ]);
  });

  it('tolerates Windows paths and no title', () => {
    expect(parsePlan('- `src\\x.ts` why').entries).toEqual([{ path: 'src/x.ts', reason: 'why' }]);
    expect(parsePlan('- `./src//y.ts` why').entries).toEqual([{ path: 'src/y.ts', reason: 'why' }]);
    expect(parsePlan('- `src\\x.ts` why').title).toBeUndefined();
  });
});

describe('applyPlan', () => {
  const steps: Step[] = [
    { kind: 'rename', path: 'lib/util.ts', from: 'util.ts' },
    { kind: 'create', path: 'a.ts', changes: 1 },
    { kind: 'modify', path: 'b.ts', changes: 2 },
    { kind: 'delete', path: 'old.ts' },
  ];

  it('orders planned steps first, with reasons; the rest keep their order', () => {
    const plan = parsePlan('1. `b.ts` — do b first\n2. `util.ts` — move it\n3. `old.ts` — drop it\n');
    expect(applyPlan(steps, plan).map((s) => `${s.path}${s.reason ? ` (${s.reason})` : ''}`)).toEqual([
      'b.ts (do b first)',
      'lib/util.ts (move it)',
      'old.ts (drop it)',
      'a.ts',
    ]);
  });

  it('leaves steps alone without a plan', () => {
    expect(applyPlan(steps, undefined)).toEqual(steps);
  });
});
