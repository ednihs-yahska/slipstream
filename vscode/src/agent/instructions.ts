/**
 * Instructions for the coding agent: a human will retype its changes, so keep
 * diffs small and leave a plan. Written into CLAUDE.md / AGENTS.md (or a
 * personal file) inside markers, so re-running setup updates it in place.
 */
export const START = '<!-- slipstream:start -->';
export const END = '<!-- slipstream:end -->';

export const INSTRUCTIONS = `## Slipstream: a human retypes your changes

The developer practises by retyping your changes by hand (with the Slipstream VS Code extension). Help them:

- **Keep diffs focused.** Change only what the task needs. Don't reformat, reorder or rename code you aren't otherwise changing.
- **Leave a plan.** Before or while you edit, write \`.slipstream/plan.md\`: the files to touch, in the order a person should write them (what's needed first, then what uses it), each with a one-line reason:

  \`\`\`markdown
  # Plan: Add greeting options
  1. \`src/types.ts\`: add \`GreetOptions\`, used by \`greet()\`
  2. \`src/greet.ts\`: accept options; add the excited variant
  3. \`src/legacy.ts\`: delete, replaced by the options
  \`\`\`

  Keep it up to date if the plan changes. Don't commit it.
- **Stay out of practice folders.** Don't read or change anything under \`.slipstream/\` except \`plan.md\`: that's the developer's practice copy, not the project.
- **If the \`slipstream_*\` tools are available,** use \`slipstream_progress\` to see where the developer is before explaining a step, and \`slipstream_read_practice_file\` to look at what they typed (never edit it).`;

/** Insert or replace the Slipstream section in a markdown file's text. */
export function mergeSection(existing: string | undefined, section = INSTRUCTIONS): string {
  const block = `${START}\n${section}\n${END}`;
  if (!existing || !existing.trim()) return block + '\n';
  const start = existing.indexOf(START);
  const end = existing.indexOf(END, start);
  if (start >= 0 && end >= 0) return existing.slice(0, start) + block + existing.slice(end + END.length);
  return existing.replace(/\s*$/, '') + '\n\n' + block + '\n';
}

/** Remove the Slipstream section, if present. */
export function removeSection(existing: string): string {
  const start = existing.indexOf(START);
  const end = existing.indexOf(END, start);
  if (start < 0 || end < 0) return existing;
  return (existing.slice(0, start).replace(/\s*$/, '') + existing.slice(end + END.length).replace(/^\s*/, '\n')).replace(/^\n+/, '');
}
