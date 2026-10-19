import { z } from 'zod';
import { getTrace, listTraceOperations, searchTraces } from './src/integrations/jaeger.js';
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

  // Traces from Jaeger (JAEGER_URL). Results are short text summaries, not raw spans.
  defineTool({
    name: 'list_trace_operations',
    description:
      'List the services that send traces, or, given a service, the operations (span names) it handles and calls, by span kind. Use this first to learn what to search for.',
    parameters: z.object({
      service: z.string().nullable().describe('A service name, or null to list all services'),
    }),
    execute: ({ service }) => listTraceOperations(service ?? undefined),
    knowledgeFile: 'skills/jaeger.md',
  }),
  defineTool({
    name: 'search_traces',
    description:
      'Find recent traces for a service and summarize each one: services involved, errors and where they happened, and the business attributes on its spans. Starts with a tally of attribute values across the traces.',
    parameters: z.object({
      service: z.string().describe('Service whose spans must appear in the trace, for example "checkout"'),
      operation: z.string().nullable().describe('Exact operation (span name) from list_trace_operations, or null'),
      errorsOnly: z.boolean().nullable().describe('true to return only traces with a failed span'),
      attributes: z
        .record(z.string(), z.string())
        .nullable()
        .describe('Span attributes that must match exactly, for example {"demo.product.id": "OLJCESPC7Z"}, or null'),
      minDurationMs: z.number().nullable().describe('Only traces at least this slow, or null'),
      lookbackMinutes: z.number().nullable().describe('How far back to search, default 15'),
      limit: z.number().nullable().describe('How many traces to summarize, default 10, max 20'),
    }),
    execute: (input) => searchTraces(input),
    knowledgeFile: 'skills/jaeger.md',
  }),
  defineTool({
    name: 'get_trace',
    description:
      'Show one trace as a tree of spans: service, operation, kind, duration, errors and business attributes. Use a trace ID from search_traces or from logs.',
    parameters: z.object({
      traceId: z.string().describe('32-character hex trace ID'),
    }),
    execute: ({ traceId }) => getTrace(traceId),
    knowledgeFile: 'skills/jaeger.md',
  }),
];
