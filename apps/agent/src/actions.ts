import { randomUUID } from 'node:crypto';
import { llm } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { STEPS_TOPIC, type StepEvent } from '@vic/shared';
import { z } from 'zod';

/** What every action returns until it is wired to a real system. */
const NOT_CONNECTED =
  'This action is not connected to a real system yet. The request was logged on the agent terminal. No data was returned.';

function formatInput(args: Record<string, unknown>) {
  return Object.entries(args)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
}

/**
 * Incident actions the agent can take. For now each one only logs to the terminal,
 * and reports its start and end to the call page so the steps show up in the chat.
 */
export function createActions(room: Room) {
  const publish = (event: StepEvent) =>
    room.localParticipant?.sendText(JSON.stringify(event), { topic: STEPS_TOPIC }).catch((err) => {
      console.error('[steps] failed to publish', err);
    });

  function action<S extends z.ZodObject>(name: string, description: string, parameters: S) {
    return llm.tool({
      name,
      description,
      parameters,
      execute: async (args) => {
        const id = randomUUID();
        const input = formatInput(args as Record<string, unknown>);
        await publish({ type: 'tool_start', id, name, input, at: Date.now() });
        console.log(`[action] ${name} ${input}`);
        await publish({ type: 'tool_end', id, output: NOT_CONNECTED, error: false, at: Date.now() });
        return NOT_CONNECTED;
      },
    });
  }

  return [
    action(
      'search_logs',
      'Search application logs for a service.',
      z.object({
        service: z.string().describe('Service name, for example "checkout"'),
        level: z.enum(['error', 'warn', 'info']).nullable().describe('Minimum log level, or null for all'),
        since: z.string().describe('How far back to look, for example "15m" or "1h"'),
        query: z.string().nullable().describe('Optional text to match, or null'),
      }),
    ),
    action(
      'query_metrics',
      'Run a Prometheus query against the metrics backend.',
      z.object({
        promql: z.string().describe('The PromQL expression'),
        range: z.string().describe('Time range, for example "30m"'),
      }),
    ),
    action(
      'list_deploys',
      'List recent deploys for a service.',
      z.object({
        service: z.string().describe('Service name'),
        since: z.string().describe('How far back to look, for example "1h"'),
      }),
    ),
  ];
}
