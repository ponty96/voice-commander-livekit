import { fileURLToPath } from 'node:url';
import { llm } from '@livekit/agents';
import type { ToolConfig } from './define.js';
import { type Publish, createRedactor, runTool } from './events.js';
import { callResultToText, connectMcpServers, mcpToolName } from './mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** The raw JSON Schema form llm.tool() accepts for parameters (MCP tools describe inputs this way). */
type JsonSchemaParameters = Exclude<Parameters<typeof llm.tool>[0]['parameters'], undefined>;

export const DEFAULT_MCP_CONFIG = fileURLToPath(new URL('../../mcp.json', import.meta.url));

/**
 * Builds every tool the LLM gets: the custom tools from tools.config.ts plus the tools
 * discovered on each MCP server in mcp.json. All of them run through runTool, so each call
 * publishes tool_start and tool_end. Call close() when the session ends.
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

  for (const tool of customTools) {
    tools[tool.name] = llm.tool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: (args) => runTool({ name: tool.name, args, publish, redact, run: () => tool.execute(args) }),
    });
  }

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
  return { tools: Object.values(tools), close };
}
