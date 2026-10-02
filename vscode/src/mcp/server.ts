import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { listPracticeFolders, practiceProgress, readPracticeFile } from './tools';

/**
 * Slipstream's MCP server (stdio). Read-only tools that let a coding agent
 * see the human's practice progress: register it with
 *   claude mcp add slipstream --scope local -- node <path>/mcp.js
 */
const server = new McpServer({ name: 'slipstream', version: '0.1.0' });
const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: (e as Error).message }], isError: true });
const readOnly = { readOnlyHint: true, openWorldHint: false };

server.registerTool(
  'slipstream_list_practice_folders',
  {
    title: 'List practice folders',
    description:
      'Slipstream practice folders for a project: folders where the developer retypes your changes by hand. Use the current project directory.',
    inputSchema: { project_dir: z.string().describe('Absolute path of the project') },
    annotations: readOnly,
  },
  async ({ project_dir }) => {
    try {
      return json(listPracticeFolders(project_dir));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'slipstream_progress',
  {
    title: 'Practice progress',
    description:
      "What the developer still has to retype in a practice folder, in order: files to create, change, move, delete or copy, each with its reason (from .slipstream/plan.md) and the names it adds. Use it to see where they are before explaining the next step.",
    inputSchema: { practice_dir: z.string().describe('Absolute path of the practice folder') },
    annotations: readOnly,
  },
  async ({ practice_dir }) => {
    try {
      return json(await practiceProgress(practice_dir));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'slipstream_read_practice_file',
  {
    title: 'Read a practice file',
    description:
      "The developer's current, hand-typed version of a file in their practice folder, to explain a difference, review their variation, or answer a question about what they wrote. Read-only.",
    inputSchema: {
      practice_dir: z.string().describe('Absolute path of the practice folder'),
      path: z.string().describe('File path relative to the practice folder, e.g. src/greet.ts'),
    },
    annotations: readOnly,
  },
  async ({ practice_dir, path }) => {
    try {
      return { content: [{ type: 'text' as const, text: readPracticeFile(practice_dir, path) }] };
    } catch (e) {
      return fail(e);
    }
  },
);

void server.connect(new StdioServerTransport());
