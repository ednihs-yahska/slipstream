import * as vscode from 'vscode';

/**
 * Copy the bundled MCP server to the extension's global storage: a path that
 * stays the same across extension updates (the install folder's name has the
 * version in it), so an agent registered once keeps working.
 */
export async function installMcpServer(context: vscode.ExtensionContext): Promise<vscode.Uri> {
  const dest = vscode.Uri.joinPath(context.globalStorageUri, 'mcp.js');
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  await vscode.workspace.fs.copy(vscode.Uri.joinPath(context.extensionUri, 'dist', 'mcp.js'), dest, { overwrite: true });
  return dest;
}

/** Keep an installed copy up to date after the extension updates. */
export async function refreshMcpServer(context: vscode.ExtensionContext) {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(context.globalStorageUri, 'mcp.js'));
    await installMcpServer(context);
  } catch {
    // never installed
  }
}

export function claudeAddCommand(script: string): string {
  return `claude mcp add slipstream --scope local -- node ${JSON.stringify(script)}`;
}

/**
 * "Connect Your Agent (MCP)": give the agent read-only tools to see your
 * practice progress. Shows the Claude Code command; never runs it for you.
 */
export async function connectAgent(context: vscode.ExtensionContext, opts: { show?: boolean } = {}): Promise<string> {
  const script = (await installMcpServer(context)).fsPath;
  const cmd = claudeAddCommand(script);
  if (opts.show === false) return cmd;

  const choice = await vscode.window.showInformationMessage(
    'Give your agent read-only tools to see your practice progress (steps left, reasons, what you typed). For Claude Code, run this in your project. Other agents: run "node" with the same script path as a stdio MCP server.',
    { modal: true, detail: cmd },
    'Copy Command',
    'Put It in a Terminal',
  );
  if (choice === 'Copy Command') {
    await vscode.env.clipboard.writeText(cmd);
    void vscode.window.showInformationMessage('Copied. Run it in your project folder.');
  }
  if (choice === 'Put It in a Terminal') {
    const terminal = vscode.window.createTerminal({ name: 'Slipstream', cwd: vscode.workspace.workspaceFolders?.[0]?.uri });
    terminal.show();
    terminal.sendText(cmd, false); // typed, not run: press Enter when you're happy with it
  }
  return cmd;
}
