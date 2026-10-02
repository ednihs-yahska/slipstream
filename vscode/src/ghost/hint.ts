import { definedSymbols } from '../steps/deps';

/**
 * Hint mode: instead of the code, a nudge about it, e.g.
 *   "◂ 4 lines · starts with `export` · defines clamp"
 */
export function hintFor(text: string): string {
  const body = text.replace(/\s+$/, '');
  const lines = body.split('\n').length;
  const first = /[\w$]+|\S/.exec(body.trimStart())?.[0];
  const symbols = definedSymbols(body.split('\n').map((l) => l.trimStart()).join('\n'));
  return [
    `◂ ${lines} line${lines === 1 ? '' : 's'}`,
    ...(first ? [`starts with \`${first}\``] : []),
    ...(symbols.length ? [`defines ${symbols.slice(0, 3).join(', ')}`] : []),
  ].join(' · ');
}
