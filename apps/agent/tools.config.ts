import { z } from 'zod';
import { defineTool } from './src/tools/define.js';

/**
 * Custom tools the agent gives the LLM. Add a defineTool(...) entry here and the agent
 * picks it up on the next call; nothing else needs to change. MCP servers go in mcp.json.
 */

/** What the placeholder tools return until they are wired to a real system. */
const NOT_CONNECTED =
  'This action is not connected to a real system yet. The request was logged on the agent terminal. No data was returned.';

export default [
  defineTool({
    name: 'search_logs',
    description: 'Search application logs for a service.',
    parameters: z.object({
      service: z.string().describe('Service name, for example "checkout"'),
      level: z.enum(['error', 'warn', 'info']).nullable().describe('Minimum log level, or null for all'),
      since: z.string().describe('How far back to look, for example "15m" or "1h"'),
      query: z.string().nullable().describe('Optional text to match, or null'),
    }),
    execute: async () => NOT_CONNECTED,
  }),
  defineTool({
    name: 'query_metrics',
    description: 'Run a Prometheus query against the metrics backend.',
    parameters: z.object({
      promql: z.string().describe('The PromQL expression'),
      range: z.string().describe('Time range, for example "30m"'),
    }),
    execute: async () => NOT_CONNECTED,
  }),
  defineTool({
    name: 'list_deploys',
    description: 'List recent deploys for a service.',
    parameters: z.object({
      service: z.string().describe('Service name'),
      since: z.string().describe('How far back to look, for example "1h"'),
    }),
    execute: async () => NOT_CONNECTED,
  }),
];
