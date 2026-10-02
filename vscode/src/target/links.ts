import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A practice folder is any folder containing `.slipstream/link.json`:
 *
 *   { "target": "../.." }        (absolute, or relative to the practice folder)
 *
 * A file at `<practice>/src/a.ts` is typed towards `<target>/src/a.ts`.
 *
 * With `"ref"` (a commit), the target is that commit's version of the files,
 * read from git, instead of the working tree. `"replay"` holds the commits of
 * a range replay and which one is current.
 * The link lives with the practice folder, so it works whether that folder is
 * inside the project, elsewhere on disk, or open in its own window.
 */
export const META_DIR = '.slipstream';
export const LINK_FILE = path.join(META_DIR, 'link.json');

export interface Replay {
  /** Commits to replay, oldest first (full hashes). */
  commits: string[];
  /** Index of the commit being typed now; `ref` is `commits[index]`. */
  index: number;
}

export interface Link {
  practiceRoot: string;
  targetRoot: string;
  /** Commit whose files are the target; undefined = the working tree. */
  ref?: string;
  replay?: Replay;
}

export type LinkExtras = Pick<Link, 'ref' | 'replay'>;

const cache = new Map<string, Link | null>();

export function clearLinkCache() {
  cache.clear();
}

export function readLink(practiceRoot: string): Link | undefined {
  try {
    const { target, ref, replay } = JSON.parse(fs.readFileSync(path.join(practiceRoot, LINK_FILE), 'utf8'));
    if (typeof target !== 'string' || !target) return undefined;
    const expanded = target.startsWith('~') ? path.join(os.homedir(), target.slice(1)) : target;
    const link: Link = { practiceRoot, targetRoot: path.resolve(practiceRoot, expanded) };
    if (typeof ref === 'string' && ref) link.ref = ref;
    if (replay && Array.isArray(replay.commits) && typeof replay.index === 'number') link.replay = replay;
    return link;
  } catch {
    return undefined;
  }
}

/** Stores the target relative to the practice folder when one contains the other, so the pair can move together. */
export function writeLink(practiceRoot: string, targetRoot: string, extras: LinkExtras = {}) {
  const rel = path.relative(practiceRoot, targetRoot);
  const nested = isInside(practiceRoot, targetRoot) || isInside(targetRoot, practiceRoot);
  const target = nested ? rel.split(path.sep).join('/') || '.' : targetRoot;
  fs.mkdirSync(path.join(practiceRoot, META_DIR), { recursive: true });
  fs.writeFileSync(path.join(practiceRoot, LINK_FILE), JSON.stringify({ target, ...extras }, null, 2) + '\n');
  clearLinkCache();
}

/** The nearest practice folder containing `file`. */
export function findLink(file: string): Link | undefined {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    let link = cache.get(dir);
    if (link === undefined) {
      link = readLink(dir) ?? null;
      cache.set(dir, link);
    }
    if (link) return link;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** Where `file` should end up, or undefined if it isn't a practice file. */
export function targetPathFor(file: string): string | undefined {
  const link = findLink(file);
  if (!link) return undefined;
  const { practiceRoot, targetRoot } = link;
  if (practiceRoot === targetRoot) return undefined;
  // Slipstream's own files (and anything nested in them) aren't practice files…
  if (isInside(file, path.join(practiceRoot, META_DIR))) return undefined;
  // …nor is a target that lives inside the practice folder.
  if (isInside(targetRoot, practiceRoot) && isInside(file, targetRoot)) return undefined;
  return path.join(targetRoot, path.relative(practiceRoot, file));
}

export function isInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
}
