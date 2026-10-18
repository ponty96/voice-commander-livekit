import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { StepEvent } from '@vic/shared';
import { z } from 'zod';
import customTools from '../tools.config.js';
import { defineTool } from '../src/tools/define.js';
import { loadTools } from '../src/tools/index.js';
// @ts-expect-error plain JS fixture without types
import { createServer as createMcpServer } from './fixtures/mcp-server.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
const TOKEN = 'test-token-123';
let httpUrl = '';
const httpServer = createHttpServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
  // Stateless HTTP: a fresh server and transport per request.
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => void transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

before(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  httpUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
});
after(() => httpServer.close());

async function setup(mcpServers: object) {
  const dir = await mkdtemp(join(tmpdir(), 'vic-mcp-'));
  const mcpConfigPath = join(dir, 'mcp.json');
  await writeFile(mcpConfigPath, JSON.stringify({ mcpServers }));
  const events: StepEvent[] = [];
  const extra = defineTool({
    name: 'add',
    description: 'Add two numbers',
    parameters: z.object({ a: z.number(), b: z.number() }),
    execute: async ({ a, b }) => a + b,
  });
  const loaded = await loadTools({
    customTools: [...customTools, extra],
    publish: async (e) => void events.push(e),
    mcpConfigPath,
  });
  const call = (name: string, args: object) => {
    const tool = loaded.tools.find((t) => t.name === name);
    assert.ok(tool, `tool ${name} is registered`);
    return tool.execute(args, {} as never) as Promise<string>;
  };
  return { ...loaded, events, call };
}

test('registers custom tools and discovers stdio and HTTP MCP tools, skipping servers with missing env', async () => {
  process.env.TEST_MCP_TOKEN = TOKEN;
  delete process.env.NOT_SET_VAR;
  const { tools, close } = await setup({
    local: { command: process.execPath, args: [FIXTURE] },
    remote: { url: httpUrl, headers: { Authorization: 'Bearer ${TEST_MCP_TOKEN}' } },
    needs_env: { url: httpUrl, headers: { Authorization: 'Bearer ${NOT_SET_VAR}' } },
  });
  try {
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'add',
      'list_deploys',
      'local__echo',
      'local__fail',
      'local__leak_secret',
      'query_metrics',
      'remote__echo',
      'remote__fail',
      'remote__leak_secret',
      'search_logs',
    ]);
  } finally {
    await close();
  }
});

test('custom and MCP tools run through the same tool_start / tool_end events', async () => {
  process.env.TEST_MCP_TOKEN = TOKEN;
  process.env.FIXTURE_SECRET = 'hunter2-very-secret';
  const { call, events, close } = await setup({
    local: { command: process.execPath, args: [FIXTURE], env: { FIXTURE_SECRET: '${FIXTURE_SECRET}' } },
    remote: { url: httpUrl, headers: { Authorization: 'Bearer ${TEST_MCP_TOKEN}' } },
  });
  try {
    assert.equal(await call('add', { a: 2, b: 3 }), '5');
    assert.match(
      await call('search_logs', { service: 'checkout', level: null, since: '15m', query: null }),
      /not connected/,
    );
    assert.equal(await call('local__echo', { text: 'hi' }), 'echo: hi');
    assert.equal(await call('remote__echo', { text: 'there' }), 'echo: there');
    await assert.rejects(call('remote__fail', {}), /upstream is down/);
    await call('local__leak_secret', {});

    const ends = events.filter((e) => e.type === 'tool_end');
    const starts = events.filter((e) => e.type === 'tool_start');
    assert.equal(starts.length, 6);
    assert.deepEqual(
      starts.map((s) => s.id),
      ends.map((e) => e.id),
    );
    assert.deepEqual(
      starts.map((s) => s.type === 'tool_start' && s.name),
      ['add', 'search_logs', 'local__echo', 'remote__echo', 'remote__fail', 'local__leak_secret'],
    );
    assert.deepEqual(
      ends.map((e) => e.type === 'tool_end' && [e.output, e.error]),
      [
        ['5', false],
        [ends[1].type === 'tool_end' ? ends[1].output : '', false],
        ['echo: hi', false],
        ['echo: there', false],
        ['upstream is down', true],
        ['secret is ***', false],
      ],
    );
    // The bearer token never shows up in any event.
    assert.ok(!JSON.stringify(events).includes(TOKEN));
  } finally {
    await close();
  }
});
