/**
 * Tab: the next word. At the end of a line, "the next word" is the line break
 * plus the next line's indentation, so Tab walks you onto the next line.
 */
export function nextWord(ghost: string): string {
  const m = /^\r?\n[ \t]*|^[ \t]*(?:\w+|[^\w\s]+)/.exec(ghost);
  return m ? m[0] : ghost.slice(0, 1);
}

/**
 * Shift+Tab: the rest of the current line. At the end of a line, it takes the
 * line break and the whole next line. If existing code follows the cursor and
 * the ghost line is a whole new line, the line break comes too, pushing that
 * code down instead of leaving it glued to the end of the new line.
 */
export function restOfLine(ghost: string, textAfterCursor = ''): string {
  const m = /^(?:\r?\n)?[^\r\n]*/.exec(ghost);
  const line = m && m[0].length > 0 ? m[0] : ghost.slice(0, 1);
  if (textAfterCursor.trim()) {
    const eol = /^\r?\n/.exec(ghost.slice(line.length));
    if (eol) return line + eol[0];
  }
  return line;
}

/** Cap ghost text so a brand-new file doesn't paint a wall of grey. */
export function truncateLines(text: string, maxLines: number): string {
  let idx = -1;
  for (let i = 0; i < maxLines; i++) {
    idx = text.indexOf('\n', idx + 1);
    if (idx === -1) return text;
  }
  return text.slice(0, idx);
}
