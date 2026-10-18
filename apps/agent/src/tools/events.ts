import { randomUUID } from 'node:crypto';
import type { Room } from '@livekit/rtc-node';
import { STEPS_TOPIC, type StepEvent } from '@vic/shared';

export type Publish = (event: StepEvent) => Promise<void>;

/** Longest output sent to the page in a tool_end event. The LLM still gets the full output. */
const MAX_EVENT_OUTPUT = 2000;

/** Sends step events to the call page on STEPS_TOPIC. Never throws. */
export function createPublisher(room: Room): Publish {
  return async (event) => {
    try {
      await room.localParticipant?.sendText(JSON.stringify(event), { topic: STEPS_TOPIC });
    } catch (err) {
      console.error('[steps] failed to publish', err);
    }
  };
}

/** Replaces any of the given secret values in text with ***. */
export function createRedactor(secrets: Iterable<string>) {
  const values = [...new Set(secrets)].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  return (text: string) => values.reduce((out, secret) => out.split(secret).join('***'), text);
}

export function formatInput(args: unknown) {
  if (!args || typeof args !== 'object') return '';
  return Object.entries(args)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
}

export function formatOutput(value: unknown) {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value);
}

const truncate = (text: string) =>
  text.length > MAX_EVENT_OUTPUT ? `${text.slice(0, MAX_EVENT_OUTPUT)}… (${text.length} chars)` : text;

export interface RunToolOptions {
  name: string;
  args: unknown;
  publish: Publish;
  run: () => unknown | Promise<unknown>;
  redact?: (text: string) => string;
}

/**
 * Runs one tool call for both custom and MCP tools: publishes tool_start, runs it, logs it,
 * and publishes tool_end with the same id, also when the tool throws. Publishing never
 * fails the call. Returns the output for the LLM, or rethrows the tool's error.
 */
export async function runTool({ name, args, publish, run, redact = (t) => t }: RunToolOptions): Promise<string> {
  const id = randomUUID();
  const input = redact(formatInput(args));
  const safePublish = (event: StepEvent) => publish(event).catch(() => {});

  await safePublish({ type: 'tool_start', id, name, input, at: Date.now() });
  console.log(`[tool] ${name} ${input}`);
  try {
    const output = formatOutput(await run());
    console.log(`[tool] ${name} done`);
    await safePublish({ type: 'tool_end', id, output: truncate(redact(output)), error: false, at: Date.now() });
    return output;
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err));
    console.error(`[tool] ${name} failed: ${message}`);
    await safePublish({ type: 'tool_end', id, output: truncate(message), error: true, at: Date.now() });
    throw err;
  }
}
