import { z } from 'zod';
import { defineTool } from './src/tools/define.js';

/**
 * Custom tools the agent gives the LLM. Add a defineTool(...) entry here and the agent
 * picks it up on the next call; nothing else needs to change. MCP servers go in mcp.json.
 */

/** What the placeholder returns until it is wired to a real system. */
const NOT_CONNECTED =
  'This action is not connected to a real system yet. The request was logged on the agent terminal. No data was returned.';

export default [
  // Template: a placeholder that only logs. Copy it, then replace execute() with a real call.
  defineTool({
    name: 'list_deploys',
    description:
      'List recent deploys for a service. Placeholder that returns no data until it is connected to a deploy system.',
    parameters: z.object({
      service: z.string().describe('Service name'),
      since: z.string().describe('How far back to look, for example "1h"'),
    }),
    execute: async () => NOT_CONNECTED,
  }),
];
