import { describe, expect, it } from 'vitest';
import { START } from '../../src/agent/instructions';
import { denyRules, mergeDenyRules, personalFiles, planSetup } from '../../src/agent/setup';

describe('denyRules', () => {
  it('blocks reading and editing each practice folder, anchored at the project root', () => {
    expect(denyRules(['.slipstream/practice', '/.slipstream/replay/'])).toEqual([
      'Read(/.slipstream/practice/**)',
      'Edit(/.slipstream/practice/**)',
      'Read(/.slipstream/replay/**)',
      'Edit(/.slipstream/replay/**)',
    ]);
  });
});

describe('mergeDenyRules', () => {
  it('creates settings from nothing', () => {
    expect(JSON.parse(mergeDenyRules(undefined, ['Read(/x/**)']))).toEqual({ permissions: { deny: ['Read(/x/**)'] } });
  });

  it('keeps existing settings and rules, without duplicates', () => {
    const existing = JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(npm test)'], deny: ['Read(/x/**)'] } });
    expect(JSON.parse(mergeDenyRules(existing, ['Read(/x/**)', 'Edit(/x/**)']))).toEqual({
      model: 'opus',
      permissions: { allow: ['Bash(npm test)'], deny: ['Read(/x/**)', 'Edit(/x/**)'] },
    });
  });

  it('refuses to overwrite a broken settings file', () => {
    expect(() => mergeDenyRules('{ nope', ['Read(/x/**)'])).toThrow(/not valid JSON/);
  });
});

describe('planSetup', () => {
  const files: Record<string, string> = { 'CLAUDE.md': '# Team rules\n' };
  const read = (rel: string) => files[rel];

  it('adds instructions to the chosen file and deny rules to local settings', () => {
    const changes = planSetup({ instructions: 'CLAUDE.md', denyFolders: ['.slipstream/practice'] }, read);
    expect(changes.map((c) => c.path)).toEqual(['CLAUDE.md', '.claude/settings.local.json']);
    expect(changes[0].content.startsWith('# Team rules\n\n' + START)).toBe(true);
  });

  it('changes nothing when already set up', () => {
    const first = planSetup({ instructions: 'CLAUDE.local.md', denyFolders: ['.slipstream/practice'] }, read);
    const after = Object.fromEntries(first.map((c) => [c.path, c.content]));
    expect(planSetup({ instructions: 'CLAUDE.local.md', denyFolders: ['.slipstream/practice'] }, (r) => after[r] ?? files[r])).toEqual([]);
  });

  it('marks personal files to keep out of git', () => {
    expect(personalFiles({ instructions: 'CLAUDE.local.md', denyFolders: ['x'] })).toEqual(['CLAUDE.local.md', '.claude/settings.local.json']);
    expect(personalFiles({ instructions: 'CLAUDE.md' })).toEqual([]);
  });
});
