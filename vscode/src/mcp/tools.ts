import * as fs from 'fs';
import * as path from 'path';
import { applyPlan, readPlan } from '../steps/plan';
import { computeSteps } from '../steps/StepModel';
import { isInside, LINK_FILE, META_DIR, readLink } from '../target/links';

/**
 * What the Slipstream MCP server tells an agent. Read-only: it never writes
 * anything. Lets the agent see how far the human has got, in what order the
 * steps come, and what they've typed, so it can explain or review.
 */

const SKIP = new Set(['.git', 'node_modules']);

/** Practice folders for a project: under it (any depth up to 6), or the folder itself. */
export function listPracticeFolders(projectDir: string) {
  const project = path.resolve(projectDir);
  const found: { practice_dir: string; target_dir: string; commit?: string }[] = [];
  const visit = (dir: string, depth: number) => {
    const link = readLink(dir);
    if (link && (isInside(link.targetRoot, project) || isInside(project, link.targetRoot))) {
      found.push({ practice_dir: dir, target_dir: link.targetRoot, ...(link.ref ? { commit: link.ref } : {}) });
    }
    if (depth === 0) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name)) visit(path.join(dir, e.name), depth - 1);
  };
  visit(project, 6);
  return found;
}

export async function practiceProgress(practiceDir: string) {
  const link = readLink(path.resolve(practiceDir));
  if (!link) throw new Error(`${practiceDir} is not a Slipstream practice folder (no ${LINK_FILE}).`);
  const plan = link.ref ? undefined : readPlan(link.targetRoot);
  const steps = applyPlan(
    await computeSteps({ practiceRoot: link.practiceRoot, targetRoot: link.targetRoot, targetRef: link.ref, lenientWhitespace: true }),
    plan,
  );
  return {
    practice_dir: link.practiceRoot,
    target_dir: link.targetRoot,
    ...(link.ref ? { commit: link.ref } : {}),
    ...(link.replay ? { replay: { commit_number: link.replay.index + 1, of: link.replay.commits.length } } : {}),
    ...(plan?.title ? { plan_title: plan.title } : {}),
    steps_left: steps.length,
    steps: steps.map((s) => ({
      kind: s.kind,
      path: s.path,
      ...(s.from ? { from: s.from } : {}),
      ...(s.changes !== undefined ? { [s.kind === 'create' ? 'lines' : 'changes_left']: s.changes } : {}),
      ...(s.reason ? { reason: s.reason } : {}),
      ...(s.symbols?.length ? { adds: s.symbols } : {}),
    })),
  };
}

/** The human's current version of a practice file. Refuses paths outside the practice folder or in its metadata. */
export function readPracticeFile(practiceDir: string, rel: string): string {
  const root = path.resolve(practiceDir);
  if (!readLink(root)) throw new Error(`${practiceDir} is not a Slipstream practice folder.`);
  const file = path.resolve(root, rel);
  if (!isInside(file, root) || isInside(file, path.join(root, META_DIR))) throw new Error(`${rel} is not a file in the practice folder.`);
  if (!fs.existsSync(file)) throw new Error(`${rel} doesn't exist in the practice folder yet (the human hasn't created it).`);
  return fs.readFileSync(file, 'utf8');
}
