import * as vscode from 'vscode';

/**
 * The "Slipstream" output channel (View → Output). Errors always; scan timings
 * at debug level (set the channel's level from its gear menu).
 */
let channel: vscode.LogOutputChannel | undefined;

export function initLog(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('Slipstream', { log: true });
  return channel;
}

export const log = {
  error: (message: string, err?: unknown) => channel?.error(message, ...(err === undefined ? [] : [err])),
  warn: (message: string) => channel?.warn(message),
  info: (message: string) => channel?.info(message),
  debug: (message: string) => channel?.debug(message),
};
