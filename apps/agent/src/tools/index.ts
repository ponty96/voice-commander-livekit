import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { llm } from '@livekit/agents';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CustomTool } from './define.js';
import type { ToolRecorder } from '../reporting/recorder.js';
import { type Publish, createRedactor, runTool } from './events.js';
import { type McpServerConnection, callResultToText, closeConnections, connectMcpServers, mcpToolName } from './mcp.js';

/** The raw JSON Schema form llm.tool() accepts for parameters (MCP tools describe inputs this way). */
type JsonSchemaParameters = Exclude<Parameters<typeof llm.tool>[0]['parameters'], undefined>;
type Redact = (text: string) => string;
type LlmTool = ReturnType<typeof wrapCustomTool> | ReturnType<typeof wrapMcpTool>;

export const DEFAULT_MCP_CONFIG = fileURLToPath(new URL('../../mcp.json', import.meta.url));
const AGENT_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** Reads the custom tools' knowledge files into instruction sections. Runs once at startup. A missing file is logged. */
export function customToolKnowledge(customTools: CustomTool[], baseDir = AGENT_DIR) {
  const byFile = new Map<string, string[]>();
  for (const tool of customTools) {
    if (tool.knowledgeFile) byFile.set(tool.knowledgeFile, [...(byFile.get(tool.knowledgeFile) ?? []), tool.name]);
  }
  const sections: string[] = [];
  for (const [file, names] of byFile) {
    try {
      const text = readFileSync(resolve(baseDir, file), 'utf8').trim();
      sections.push(`## How to use ${names.join(', ')}\n\n${text}`);
      console.log(`[tools] loaded knowledge for ${names.join(', ')} from ${file}`);
    } catch (err) {
      console.warn(`[tools] could not read knowledgeFile ${file}: ${(err as Error).message}`);
    }
  }
  return sections.join('\n\n');
}

/** Turns each connected server's knowledge_context_file into a section to add to the agent's instructions. */
export function knowledgeInstructions(connections: McpServerConnection[]) {
  return connections
    .filter((c) => c.knowledge)
    .map((c) => `## How to use the ${c.server} tools (named ${c.server}__...)\n\n${c.knowledge}`)
    .join('\n\n');
}

/** One tools.config.ts entry as an LLM tool that runs through runTool. Needs no connection. */
export function wrapCustomTool(tool: CustomTool, publish: Publish, redact?: Redact, record?: ToolRecorder) {
  return llm.tool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: (args) => runTool({ name: tool.name, args, publish, redact, record, run: () => tool.execute(args) }),
  });
}

/** One MCP tool as an LLM tool named "<server>__<tool>" that calls tools/call through runTool. */
export function wrapMcpTool(
  server: string,
  client: McpServerConnection['client'],
  tool: McpServerConnection['tools'][number],
  publish: Publish,
  redact: Redact,
  record?: ToolRecorder,
) {
  const name = mcpToolName(server, tool.name);
  return llm.tool({
    name,
    description: tool.description ?? tool.title ?? tool.name,
    parameters: tool.inputSchema as JsonSchemaParameters,
    execute: (args) =>
      runTool({
        name,
        args,
        publish,
        redact,
        server,
        record,
        run: async () => {
          const result = await client.callTool({ name: tool.name, arguments: args as Record<string, unknown> });
          return callResultToText(result as CallToolResult);
        },
      }),
  });
}

/**
 * Builds every tool the LLM gets: the custom tools from tools.config.ts plus the tools discovered
 * on each MCP server in mcp.json, all running through runTool so each call publishes tool_start and
 * tool_end. Two tools with the same name is a configuration error and throws. `instructions` holds
 * the servers' knowledge files. Call close() when the session ends; if building fails, the
 * connections are closed before the error is thrown.
 */
export async function loadTools({
  customTools,
  publish,
  record,
  mcpConfigPath = DEFAULT_MCP_CONFIG,
}: {
  customTools: CustomTool[];
  publish: Publish;
  record?: ToolRecorder;
  mcpConfigPath?: string;
}) {
  const { connections, secrets } = await connectMcpServers(mcpConfigPath);
  const close = () => closeConnections(connections);
  try {
    const redact = createRedactor(secrets);
    const tools = new Map<string, LlmTool>();
    const add = (tool: LlmTool, source: string) => {
      if (tools.has(tool.name)) throw new Error(`Duplicate tool name "${tool.name}" (from ${source})`);
      tools.set(tool.name, tool);
    };

    for (const tool of customTools) add(wrapCustomTool(tool, publish, redact, record), 'tools.config.ts');
    for (const { server, client, tools: mcpTools } of connections) {
      for (const tool of mcpTools)
        add(wrapMcpTool(server, client, tool, publish, redact, record), `MCP server ${server}`);
    }

    return { tools: [...tools.values()], instructions: knowledgeInstructions(connections), close };
  } catch (err) {
    await close();
    throw err;
  }
}
