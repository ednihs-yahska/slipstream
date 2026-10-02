import { describe, expect, it } from 'vitest';
import { END, INSTRUCTIONS, mergeSection, removeSection, START } from '../../src/agent/instructions';

describe('mergeSection', () => {
  it('creates the file content when there is none', () => {
    expect(mergeSection(undefined)).toBe(`${START}\n${INSTRUCTIONS}\n${END}\n`);
  });

  it('appends after existing content, once', () => {
    const once = mergeSection('# My project\n\nBe nice.\n');
    expect(once.startsWith('# My project\n\nBe nice.\n\n' + START)).toBe(true);
    expect(mergeSection(once)).toBe(once);
  });

  it('replaces an older version in place, keeping what surrounds it', () => {
    const old = `# P\n\n${START}\nold text\n${END}\n\n## After\n`;
    const merged = mergeSection(old);
    expect(merged).toBe(`# P\n\n${START}\n${INSTRUCTIONS}\n${END}\n\n## After\n`);
  });

  it('can be removed again', () => {
    expect(removeSection(mergeSection('# P\n\nBe nice.\n'))).toBe('# P\n\nBe nice.\n');
  });
});

it('tells the agent the plan format the extension parses', async () => {
  const { parsePlan } = await import('../../src/steps/plan');
  const example = /```markdown\n([\s\S]*?)```/.exec(INSTRUCTIONS)![1].replace(/^ {2}/gm, '');
  const plan = parsePlan(example);
  expect(plan.title).toBe('Add greeting options');
  expect(plan.entries.map((e) => e.path)).toEqual(['src/types.ts', 'src/greet.ts', 'src/legacy.ts']);
});
