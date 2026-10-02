import * as fs from 'fs';
import * as path from 'path';
import { META_DIR } from '../target/links';
import { Step } from './StepModel';

/**
 * Optional progress stored in the practice folder (`.slipstream/progress.json`)
 * so it travels with a practice repository. Off until the file exists. Keyed
 * by what is being typed — a commit or branch label, or "working-tree" — never
 * by absolute paths, so a clone on another machine reads the same entry.
 * Last write wins: two machines practising the same folder at once overwrite
 * each other's progress, not each other's code.
 */
export const PROGRESS_FILE = path.join(META_DIR, 'progress.json');

export interface StoredStats {
  typed: number;
  accepted: number;
  startedAt: number;
  keys?: number;
  chars?: number;
  corrections?: number;
  activeMs?: number;
}

export interface StoredProgress {
  seen: Record<string, Step>;
  stats: StoredStats;
}

type ProgressFile = { version: 1; sessions: Record<string, StoredProgress> };

export function progressKey(refLabel: string | undefined): string {
  return refLabel ?? 'working-tree';
}

function file(practiceRoot: string): string {
  return path.join(practiceRoot, PROGRESS_FILE);
}

export function hasProgressFile(practiceRoot: string): boolean {
  return fs.existsSync(file(practiceRoot));
}

function load(practiceRoot: string): ProgressFile | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file(practiceRoot), 'utf8'));
    return v && typeof v === 'object' && v.sessions && typeof v.sessions === 'object' ? v : { version: 1, sessions: {} };
  } catch {
    return undefined;
  }
}

export function readProgress(practiceRoot: string, key: string): StoredProgress | undefined {
  return load(practiceRoot)?.sessions[key];
}

/** Writes only if the practice folder has opted in (the file exists). */
export function writeProgress(practiceRoot: string, key: string, progress: StoredProgress): boolean {
  const current = load(practiceRoot);
  if (!current) return false;
  current.sessions[key] = progress;
  fs.writeFileSync(file(practiceRoot), JSON.stringify(current, null, 2) + '\n');
  return true;
}

/** Opt in: create the file, seeded with the current progress. */
export function createProgressFile(practiceRoot: string, key: string, progress: StoredProgress) {
  fs.mkdirSync(path.join(practiceRoot, META_DIR), { recursive: true });
  const data: ProgressFile = { version: 1, sessions: { [key]: progress } };
  fs.writeFileSync(file(practiceRoot), JSON.stringify(data, null, 2) + '\n');
}
