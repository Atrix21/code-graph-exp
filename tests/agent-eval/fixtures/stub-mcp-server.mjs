// Tiny stdio MCP server exposing `search_code` (same tool name/shape as the experiment's retrieval server).
// Used to test the Claude Code integration without building any index. Appends each call to --log if given.
import fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const i = process.argv.indexOf('--log');
const log = i >= 0 ? process.argv[i + 1] : null;
const server = new Server({ name: 'stub-retrieval', version: '0.0.1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'search_code', description: 'Search this codebase (stub).', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (log) fs.appendFileSync(log, JSON.stringify({ ts: Date.now(), args: req.params.arguments }) + '\n');
  return { content: [{ type: 'text', text: '// src/auth/auth.service.ts:1-2 AuthService.refreshToken\nstub result for: ' + JSON.stringify(req.params.arguments) }] };
});
await server.connect(new StdioServerTransport());
