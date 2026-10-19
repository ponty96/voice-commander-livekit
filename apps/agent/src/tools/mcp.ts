import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * One entry under "mcpServers" in mcp.json: a local stdio server or a remote HTTP one.
 * `knowledge_context_file` is a Markdown file (relative to mcp.json) telling the LLM how to use its tools.
 */
export type McpServerConfig = { knowledge_context_file?: string } & (
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { url: string; headers?: Record<string, string> }
);

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpServerConnection {
  server: string;
  client: Client;
  tools: Tool[];
  /** Contents of the server's knowledge_context_file, if it has one. */
  knowledge?: string;
}

// Python servers can take 30s+ to start when Docker's CPUs are busy. The call doesn't wait on this.
const CONNECT_TIMEOUT_MS = 60_000;

export async function readMcpConfig(path: string): Promise<McpConfig> {
  try {
    const config = JSON.parse(await readFile(path, 'utf8')) as Partial<McpConfig>;
    return { mcpServers: config.mcpServers ?? {} };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { mcpServers: {} };
    throw new Error(`Could not read ${path}: ${(err as Error).message}`);
  }
}

/**
 * Replaces ${VAR} in every string of a server config with process.env values.
 * Returns the names of variables that are not set, and every resolved value (to redact later).
 */
export function resolveEnv<T>(value: T, env: NodeJS.ProcessEnv = process.env) {
  const missing = new Set<string>();
  const secrets = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
        const resolved = env[name];
        if (resolved === undefined || resolved === '') missing.add(name);
        else secrets.add(resolved);
        return resolved ?? '';
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value) as T, missing: [...missing], secrets: [...secrets] };
}

/** LLM-safe tool name, prefixed with the server name: "grafana__query_prometheus". */
export function mcpToolName(server: string, tool: string) {
  return `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function createTransport(config: McpServerConfig) {
  if ('url' in config) {
    return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
  }
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    // Keep PATH and friends so commands like uvx and npx resolve.
    env: { ...getDefaultEnvironment(), ...config.env },
    stderr: 'inherit',
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Connects to one MCP server and lists all its tools (following pagination). */
export async function connectMcpServer(server: string, config: McpServerConfig): Promise<McpServerConnection> {
  const client = new Client({ name: 'voice-incident-commander', version: '0.0.0' });
  try {
    await withTimeout(client.connect(createTransport(config)), CONNECT_TIMEOUT_MS, `connecting to ${server}`);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return { server, client, tools };
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}

/** Turns a tools/call result into text for the LLM. Throws if the server flagged it as an error. */
export function callResultToText(result: CallToolResult) {
  const parts = (result.content ?? []).map((part) => {
    if (part.type === 'text') return part.text;
    if (part.type === 'resource' && 'text' in part.resource) return part.resource.text;
    if (part.type === 'resource_link') return `[resource ${part.uri}]`;
    return `[${part.type} content]`;
  });
  if (parts.length === 0 && result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join('\n');
  if (result.isError) throw new Error(text || 'MCP tool returned an error');
  return text;
}

/** Reads a server's knowledge_context_file, relative to mcp.json. A missing file is logged, not fatal. */
export async function readKnowledge(server: string, mcpConfigPath: string, file: string | undefined) {
  if (!file) return undefined;
  const fullPath = resolve(dirname(mcpConfigPath), file);
  try {
    const text = (await readFile(fullPath, 'utf8')).trim();
    console.log(`[mcp] ${server}: loaded knowledge from ${file}`);
    return text;
  } catch (err) {
    console.warn(`[mcp] ${server}: could not read knowledge_context_file ${file}: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Reads mcp.json, resolves ${VAR}s from the environment and connects to every server in parallel.
 * A server with missing variables or a failed connection is skipped with a log line, so one bad
 * server never stops the agent. Returns the live connections and the secret values to redact.
 */
export async function connectMcpServers(path: string) {
  const { mcpServers } = await readMcpConfig(path);
  const secrets: string[] = [];
  const results = await Promise.all(
    Object.entries(mcpServers).map(async ([server, raw]) => {
      const { value: config, missing, secrets: found } = resolveEnv(raw);
      if (missing.length) {
        console.warn(`[mcp] skipping ${server}: set ${missing.join(', ')} to enable it`);
        return null;
      }
      secrets.push(...found);
      try {
        const connection = await connectMcpServer(server, config);
        connection.knowledge = await readKnowledge(server, path, config.knowledge_context_file);
        console.log(
          `[mcp] ${server}: ${connection.tools.length} tools (${connection.tools.map((t) => t.name).join(', ')})`,
        );
        return connection;
      } catch (err) {
        console.error(`[mcp] skipping ${server}: ${(err as Error).message}`);
        return null;
      }
    }),
  );
  return { connections: results.filter((c): c is McpServerConnection => c !== null), secrets };
}
