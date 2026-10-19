import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { llm } from '@livekit/agents';
import type { ToolConfig } from './define.js';
import { type Publish, createRedactor, runTool } from './events.js';
import { type McpServerConnection, callResultToText, connectMcpServers, mcpToolName } from './mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** The raw JSON Schema form llm.tool() accepts for parameters (MCP tools describe inputs this way). */
type JsonSchemaParameters = Exclude<Parameters<typeof llm.tool>[0]['parameters'], undefined>;

export const DEFAULT_MCP_CONFIG = fileURLToPath(new URL('../../mcp.json', import.meta.url));
const AGENT_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** Reads the custom tools' knowledge files into instruction sections. A missing file is logged, not fatal. */
export function customToolKnowledge(customTools: ToolConfig<any>[], baseDir = AGENT_DIR) {
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

/** Turns the tools.config.ts entries into LLM tools that run through runTool. No connections needed. */
export function wrapCustomTools(customTools: ToolConfig<any>[], publish: Publish, redact?: (text: string) => string) {
  return customTools.map((tool) =>
    llm.tool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: (args) => runTool({ name: tool.name, args, publish, redact, run: () => tool.execute(args) }),
    }),
  );
}

/** Turns each connected server's knowledge_context_file into a section to add to the agent's instructions. */
export function knowledgeInstructions(connections: McpServerConnection[]) {
  return connections
    .filter((c) => c.knowledge)
    .map((c) => `## How to use the ${c.server} tools (named ${c.server}__...)\n\n${c.knowledge}`)
    .join('\n\n');
}

/**
 * Builds every tool the LLM gets: the custom tools from tools.config.ts plus the tools
 * discovered on each MCP server in mcp.json. All of them run through runTool, so each call
 * publishes tool_start and tool_end. `instructions` holds the servers' knowledge files for the
 * agent's instructions. Call close() when the session ends.
 */
export async function loadTools({
  customTools,
  publish,
  mcpConfigPath = DEFAULT_MCP_CONFIG,
}: {
  customTools: ToolConfig<any>[];
  publish: Publish;
  mcpConfigPath?: string;
}) {
  const { connections, secrets } = await connectMcpServers(mcpConfigPath);
  const redact = createRedactor(secrets);
  const tools: Record<string, llm.FunctionTool<any, any, any>> = {};

  for (const tool of wrapCustomTools(customTools, publish, redact)) tools[tool.name] = tool;

  for (const { server, client, tools: mcpTools } of connections) {
    for (const mcpTool of mcpTools) {
      const name = mcpToolName(server, mcpTool.name);
      if (tools[name]) {
        console.warn(`[mcp] ${server}: skipping ${mcpTool.name}, the name ${name} is already taken`);
        continue;
      }
      tools[name] = llm.tool({
        name,
        description: mcpTool.description ?? mcpTool.title ?? mcpTool.name,
        parameters: mcpTool.inputSchema as JsonSchemaParameters,
        execute: (args) =>
          runTool({
            name,
            args,
            publish,
            redact,
            run: async () =>
              callResultToText(
                (await client.callTool({
                  name: mcpTool.name,
                  arguments: args as Record<string, unknown>,
                })) as CallToolResult,
              ),
          }),
      });
    }
  }

  const close = async () => {
    await Promise.all(connections.map((c) => c.client.close().catch(() => {})));
  };
  return { tools: Object.values(tools), instructions: knowledgeInstructions(connections), close };
}
