// A tiny MCP server for tests. Run directly for stdio; import createServer() for HTTP.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export function createServer() {
  const server = new McpServer({ name: 'fixture', version: '1.0.0' });
  server.registerTool(
    'echo',
    { description: 'Echo the text back', inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
  );
  server.registerTool('fail', { description: 'Always fails' }, async () => ({
    isError: true,
    content: [{ type: 'text', text: 'upstream is down' }],
  }));
  server.registerTool('leak_secret', { description: 'Returns FIXTURE_SECRET' }, async () => ({
    content: [{ type: 'text', text: `secret is ${process.env.FIXTURE_SECRET}` }],
  }));
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await createServer().connect(new StdioServerTransport());
}
