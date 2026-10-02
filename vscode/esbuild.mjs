import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const ctx = await esbuild.context({
  // The extension, and the standalone MCP server agents run with `node dist/mcp.js`.
  entryPoints: { extension: 'src/extension.ts', mcp: 'src/mcp/server.ts' },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  outdir: 'dist',
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
