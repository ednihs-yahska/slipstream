import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearLinkCache, readLink, targetPathFor, writeLink } from '../../src/target/links';

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-links-')));
  clearLinkCache();
});
const p = (...parts: string[]) => path.join(tmp, ...parts);

describe('practice inside the project (default)', () => {
  beforeEach(() => writeLink(p('proj/.slipstream/practice'), p('proj')));

  it('stores the link relative so the project can move', () => {
    expect(JSON.parse(fs.readFileSync(p('proj/.slipstream/practice/.slipstream/link.json'), 'utf8'))).toEqual({
      target: '../..',
    });
    expect(readLink(p('proj/.slipstream/practice'))?.targetRoot).toBe(p('proj'));
  });

  it('maps practice files to project files', () => {
    expect(targetPathFor(p('proj/.slipstream/practice/src/a.ts'))).toBe(p('proj/src/a.ts'));
  });

  it('leaves project files alone', () => {
    expect(targetPathFor(p('proj/src/a.ts'))).toBeUndefined();
  });

  it('ignores the practice folder’s own metadata', () => {
    expect(targetPathFor(p('proj/.slipstream/practice/.slipstream/link.json'))).toBeUndefined();
  });
});

describe('practice folder elsewhere on disk', () => {
  beforeEach(() => writeLink(p('elsewhere/practice'), p('proj')));

  it('stores an absolute target', () => {
    expect(JSON.parse(fs.readFileSync(p('elsewhere/practice/.slipstream/link.json'), 'utf8')).target).toBe(p('proj'));
  });

  it('maps practice files to project files', () => {
    expect(targetPathFor(p('elsewhere/practice/src/deep/a.ts'))).toBe(p('proj/src/deep/a.ts'));
  });
});

describe('reverse: practise in the project, agent writes to a shadow inside it', () => {
  beforeEach(() => writeLink(p('proj'), p('proj/.slipstream/shadow')));

  it('maps project files to the shadow', () => {
    expect(targetPathFor(p('proj/src/a.ts'))).toBe(p('proj/.slipstream/shadow/src/a.ts'));
  });

  it('does not treat shadow files as practice files', () => {
    expect(targetPathFor(p('proj/.slipstream/shadow/src/a.ts'))).toBeUndefined();
  });
});

it('expands ~ in a hand-written link', () => {
  fs.mkdirSync(p('x/.slipstream'), { recursive: true });
  fs.writeFileSync(p('x/.slipstream/link.json'), '{ "target": "~/code/proj" }');
  expect(readLink(p('x'))?.targetRoot).toBe(path.join(os.homedir(), 'code/proj'));
});

it('returns nothing outside any practice folder', () => {
  expect(targetPathFor(p('nowhere/a.ts'))).toBeUndefined();
});
