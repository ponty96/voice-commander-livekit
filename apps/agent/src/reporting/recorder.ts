import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRedactor } from '../tools/events.js';
import type { Facts, RecordEvent, ToolCallStatus } from './schema.js';

/** Where investigations are stored: REPORTS_DIR, or reports/investigations at the repo root. */
export const REPORTS_DIR = process.env.REPORTS_DIR
  ? resolve(process.env.REPORTS_DIR)
  : fileURLToPath(new URL('../../../../reports/investigations', import.meta.url));

/** Largest evidence file kept per tool call. */
const MAX_EVIDENCE_BYTES = 256 * 1024;

/** Patterns redacted from everything recorded, on top of known secret values. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer ***'],
  [/\b(api[_-]?key|token|secret|password|passwd|authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2***'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***'],
];

/** Values of environment variables that look like credentials (LiveKit keys, MCP tokens…). */
function secretEnvValues() {
  return Object.entries(process.env)
    .filter(([k, v]) => v && /KEY|SECRET|TOKEN|PAT|PASSWORD/i.test(k))
    .map(([, v]) => v!);
}

export function createRecordRedactor(extraSecrets: string[] = []) {
  const known = createRedactor([...secretEnvValues(), ...extraSecrets]);
  return (text: string) => SECRET_PATTERNS.reduce((out, [re, sub]) => out.replace(re, sub), known(text));
}

/** Writes a file so readers never see it half-written: write a temp file, then rename. */
export async function writeFileAtomic(path: string, data: string) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

const pad = (n: number) => String(n).padStart(3, '0');
const now = () => new Date().toISOString();

/** Called by runTool for every tool execution. */
export interface ToolRecorder {
  toolStart(e: { eventId: string; tool: string; server: string | null; input: unknown }): string;
  toolEnd(callId: string, e: { status: ToolCallStatus; durationMs: number; output?: string; error?: string }): void;
}

/**
 * Records one investigation (one LiveKit session) to disk while the call runs: an append-only
 * events.jsonl plus one evidence file per tool call. Nothing here comes from an LLM. Every write
 * is queued and failures are logged, never thrown, so recording can't break the voice session.
 */
export class InvestigationRecorder implements ToolRecorder {
  readonly dir: string;
  private queue: Promise<void> = Promise.resolve();
  private calls = 0;
  private messages = 0;
  private ended = false;

  private constructor(
    readonly investigationId: string,
    readonly room: string,
    baseDir: string,
    private readonly redact: (text: string) => string,
  ) {
    this.dir = join(baseDir, investigationId);
  }

  static start(room: string, baseDir = REPORTS_DIR) {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z');
    const safeRoom = room.replace(/[^A-Za-z0-9._-]/g, '_');
    const recorder = new InvestigationRecorder(`inv_${stamp}_${safeRoom}`, room, baseDir, createRecordRedactor());
    recorder.enqueue(() => mkdir(join(recorder.dir, 'evidence'), { recursive: true }));
    recorder.append({ type: 'investigation_start', investigationId: recorder.investigationId, room, at: now() });
    console.log(`[report] recording ${recorder.investigationId}`);
    return recorder;
  }

  private enqueue(task: () => Promise<unknown>) {
    this.queue = this.queue.then(task).then(
      () => {},
      (err) => console.error(`[report] write failed: ${(err as Error).message}`),
    );
  }

  private append(event: RecordEvent) {
    this.enqueue(() => appendFile(join(this.dir, 'events.jsonl'), `${JSON.stringify(event)}\n`));
  }

  config(llm: string, instructions: string, tools: string[]) {
    const instructionsHash = createHash('sha256').update(instructions).digest('hex');
    this.append({ type: 'config', llm, instructionsHash, tools: [...tools].sort(), at: now() });
  }

  message(role: 'user' | 'assistant', text: string, interrupted = false) {
    if (!text.trim()) return;
    this.messages += 1;
    this.append({
      type: 'message',
      msgId: `msg_${pad(this.messages)}`,
      role,
      text: this.redact(text),
      interrupted,
      at: now(),
    });
  }

  toolStart({
    eventId,
    tool,
    server,
    input,
  }: {
    eventId: string;
    tool: string;
    server: string | null;
    input: unknown;
  }) {
    this.calls += 1;
    const callId = `call_${pad(this.calls)}`;
    let safeInput: unknown = input;
    try {
      safeInput = JSON.parse(this.redact(JSON.stringify(input ?? null)));
    } catch {
      safeInput = null;
    }
    this.append({ type: 'tool_start', callId, seq: this.calls, eventId, tool, server, input: safeInput, at: now() });
    return callId;
  }

  toolEnd(
    callId: string,
    {
      status,
      durationMs,
      output,
      error,
    }: { status: ToolCallStatus; durationMs: number; output?: string; error?: string },
  ) {
    const text = this.redact(output ?? '');
    const evidence = output !== undefined ? `evidence/${callId}.txt` : null;
    if (evidence) {
      const body =
        Buffer.byteLength(text) > MAX_EVIDENCE_BYTES ? `${text.slice(0, MAX_EVIDENCE_BYTES)}\n…(truncated)` : text;
      this.enqueue(() => writeFile(join(this.dir, evidence), body));
    }
    this.append({
      type: 'tool_end',
      callId,
      status,
      durationMs,
      outputChars: output?.length ?? 0,
      evidence,
      error: error ? this.redact(error) : null,
      at: now(),
    });
  }

  /** Writes session_end and record.json. Safe to call twice; never throws. Returns the facts, if written. */
  async end(reason: string): Promise<Facts | null> {
    if (!this.ended) {
      this.ended = true;
      this.append({ type: 'session_end', reason, at: now() });
    }
    await this.queue;
    try {
      return await writeRecord(this.dir);
    } catch (err) {
      console.error(`[report] could not write record.json: ${(err as Error).message}`);
      return null;
    }
  }
}

export async function readEvents(dir: string): Promise<RecordEvent[]> {
  const text = await readFile(join(dir, 'events.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RecordEvent];
      } catch {
        return []; // a line cut short by a crash
      }
    });
}

/** Builds record.json from events.jsonl and writes it atomically. */
export async function writeRecord(dir: string) {
  const facts = buildFacts(await readEvents(dir));
  await writeFileAtomic(join(dir, 'record.json'), `${JSON.stringify(facts, null, 2)}\n`);
  return facts;
}

const ms = (iso: string) => Date.parse(iso);

/** The facts of an investigation, computed only from recorded events. */
export function buildFacts(events: RecordEvent[]): Facts {
  const start = events.find((e) => e.type === 'investigation_start');
  const end = events.find((e) => e.type === 'session_end');
  const configs = events.filter((e) => e.type === 'config');
  const messages = events.filter((e) => e.type === 'message');
  const starts = events.filter((e) => e.type === 'tool_start');
  const ends = new Map(events.filter((e) => e.type === 'tool_end').map((e) => [e.callId, e]));

  const toolCalls = starts.map((s) => {
    const e = ends.get(s.callId);
    return {
      callId: s.callId,
      seq: s.seq,
      tool: s.tool,
      server: s.server,
      startedAt: s.at,
      durationMs: e?.durationMs ?? null,
      status: e?.status ?? ('unfinished' as const),
      input: s.input,
      outputChars: e?.outputChars ?? null,
      evidence: e?.evidence ?? null,
      error: e?.error ?? null,
    };
  });

  const startedAt = start?.at ?? events[0]?.at ?? now();
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const lastToolAt = Math.max(-Infinity, ...events.filter((e) => e.type === 'tool_end').map((e) => ms(e.at)));
  const firstQuestion = messages.find((m) => m.role === 'user');
  // The first thing the agent said after its first tool result: its first conclusion.
  const firstToolEnd = events.find((e) => e.type === 'tool_end');
  const firstConclusion = firstToolEnd
    ? messages.find((m) => m.role === 'assistant' && ms(m.at) >= ms(firstToolEnd.at))
    : undefined;

  let status: Facts['status'];
  if (!end) status = 'incomplete';
  else if (!firstQuestion) status = 'abandoned';
  else if (
    /error/i.test(end.reason) ||
    toolCalls.some((c) => c.status === 'unfinished') ||
    !lastAssistant ||
    lastAssistant.interrupted ||
    ms(lastAssistant.at) < lastToolAt
  )
    status = 'interrupted';
  else status = 'completed';

  const signature = (c: (typeof toolCalls)[number]) => `${c.tool} ${JSON.stringify(c.input)}`;
  const seen = new Set<string>();
  let repeated = 0;
  for (const c of toolCalls) {
    if (seen.has(signature(c))) repeated += 1;
    seen.add(signature(c));
  }

  return {
    investigationId: start?.investigationId ?? 'unknown',
    room: start?.room ?? 'unknown',
    status,
    closeReason: end?.reason ?? null,
    startedAt,
    endedAt: end?.at ?? null,
    durationMs: end ? ms(end.at) - ms(startedAt) : null,
    agent: {
      llm: configs.at(-1)?.llm ?? null,
      configHash: configs.length
        ? createHash('sha256')
            .update(JSON.stringify(configs.map((c) => [c.instructionsHash, c.tools])))
            .digest('hex')
            .slice(0, 16)
        : null,
    },
    messages: messages.map(({ msgId, role, at, text, interrupted }) => ({ msgId, role, at, text, interrupted })),
    toolCalls,
    metrics: {
      totalToolCalls: toolCalls.length,
      successfulToolCalls: toolCalls.filter((c) => c.status === 'success').length,
      failedToolCalls: toolCalls.filter((c) => c.status === 'error').length,
      timedOutToolCalls: toolCalls.filter((c) => c.status === 'timeout').length,
      uniqueToolsUsed: new Set(toolCalls.map((c) => c.tool)).size,
      repeatedToolCalls: repeated,
      totalToolExecutionMs: toolCalls.reduce((sum, c) => sum + (c.durationMs ?? 0), 0),
      timeToFirstToolCallMs: firstQuestion && starts[0] ? ms(starts[0].at) - ms(firstQuestion.at) : null,
      timeToFirstAgentConclusionMs:
        firstQuestion && firstConclusion ? ms(firstConclusion.at) - ms(firstQuestion.at) : null,
    },
  };
}
