import { randomUUID } from 'node:crypto';
import type { Room } from '@livekit/rtc-node';
import { STEPS_TOPIC, type StepEvent } from '@vic/shared';
import type { ToolRecorder } from '../reporting/recorder.js';

export type Publish = (event: StepEvent) => Promise<void>;

/** Longest output sent to the page in a tool_end event. The LLM still gets the full output. */
const MAX_EVENT_OUTPUT = 2000;
/** A tool call that runs longer than this fails with status `timeout`. */
export const TOOL_TIMEOUT_MS = 30_000;

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
  /** MCP server the tool came from, or null for a custom tool. Recorded only. */
  server?: string | null;
  /** Records the call for the investigation report. Never allowed to fail the call. */
  record?: ToolRecorder;
  timeoutMs?: number;
}

class ToolTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ToolTimeoutError(`timed out after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Runs a recorder call so a failure there can never affect the tool call. */
function safely<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    console.error(`[report] recording failed: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Runs one tool call for both custom and MCP tools: publishes tool_start, runs it (with a
 * timeout), logs it, and publishes tool_end with the same id, also when the tool throws. The
 * same call is recorded for the investigation report. Publishing and recording never fail the
 * call. Returns the output for the LLM, or rethrows the tool's error.
 */
export async function runTool({
  name,
  args,
  publish,
  run,
  redact = (t) => t,
  server = null,
  record,
  timeoutMs = TOOL_TIMEOUT_MS,
}: RunToolOptions): Promise<string> {
  const id = randomUUID();
  const input = redact(formatInput(args));
  const safePublish = (event: StepEvent) => publish(event).catch(() => {});
  const started = Date.now();

  await safePublish({ type: 'tool_start', id, name, input, at: started });
  const callId = record && safely(() => record.toolStart({ eventId: id, tool: name, server, input: args }));
  console.log(`[tool] ${name} ${input}`);
  try {
    const output = formatOutput(await withTimeout(Promise.resolve().then(run), timeoutMs));
    console.log(`[tool] ${name} done`);
    await safePublish({ type: 'tool_end', id, output: truncate(redact(output)), error: false, at: Date.now() });
    if (callId) safely(() => record!.toolEnd(callId, { status: 'success', durationMs: Date.now() - started, output }));
    return output;
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err));
    console.error(`[tool] ${name} failed: ${message}`);
    await safePublish({ type: 'tool_end', id, output: truncate(message), error: true, at: Date.now() });
    if (callId) {
      const status = err instanceof ToolTimeoutError ? 'timeout' : 'error';
      safely(() =>
        record!.toolEnd(callId, { status, durationMs: Date.now() - started, output: message, error: message }),
      );
    }
    throw err;
  }
}
