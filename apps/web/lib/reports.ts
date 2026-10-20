import 'server-only';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Same folder the agent writes to: REPORTS_DIR, or reports/investigations at the repo root. */
export const REPORTS_DIR = resolve(process.env.REPORTS_DIR ?? join(process.cwd(), '../../reports/investigations'));

/** The parts of the agent's record.json / report.json this app shows. The agent owns the schema. */
export interface ToolCall {
  callId: string;
  seq: number;
  tool: string;
  server: string | null;
  startedAt: string;
  durationMs: number | null;
  status: string;
  input: unknown;
  evidence: string | null;
  error: string | null;
}
export interface Facts {
  investigationId: string;
  room: string;
  status: string;
  closeReason: string | null;
  startedAt: string;
  durationMs: number | null;
  messages: { msgId: string; role: string; at: string; text: string; interrupted: boolean }[];
  toolCalls: ToolCall[];
  metrics: Record<string, number | null>;
}
export interface Analysis {
  headline: string;
  request: { originalQuestionMsgId: string | null; interpretedObjective: string };
  claims: {
    id: string;
    msgId: string;
    kind: string;
    statement: string;
    expressedConfidence: string;
    support: string;
    evidence: { callId: string; quote: string }[];
  }[];
  rootCause: { statedByAgent: boolean; claimId: string | null };
  limitations: { statement: string; acknowledgedByAgent: boolean }[];
  toolCallNotes: { callId: string; note: string }[];
  generator: { model: string; generatedAt: string };
  validation: string[];
}
export interface Investigation {
  id: string;
  facts: Facts | null;
  analysis: Analysis | null;
  reportError: string | null;
}

/** Investigation ids are folder names the agent made; anything else is refused. */
export const isInvestigationId = (id: string) => /^inv_[A-Za-z0-9._-]+$/.test(id);

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function getInvestigation(id: string): Promise<Investigation | null> {
  if (!isInvestigationId(id)) return null;
  const dir = join(REPORTS_DIR, id);
  const report = await readJson<{ facts: Facts; analysis: Analysis }>(join(dir, 'report.json'));
  const facts = report?.facts ?? (await readJson<Facts>(join(dir, 'record.json')));
  const error = await readJson<{ error: string }>(join(dir, 'report.error.json'));
  if (!facts && !report) {
    // Recording has started but the call isn't over yet.
    const started = await readFile(join(dir, 'events.jsonl'), 'utf8').catch(() => null);
    if (started === null) return null;
  }
  return { id, facts, analysis: report?.analysis ?? null, reportError: report ? null : (error?.error ?? null) };
}

export async function listInvestigations(): Promise<Investigation[]> {
  const entries = await readdir(REPORTS_DIR, { withFileTypes: true }).catch(() => []);
  const ids = entries
    .filter((e) => e.isDirectory() && isInvestigationId(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  return (await Promise.all(ids.map(getInvestigation))).filter((i): i is Investigation => i !== null);
}

export async function readEvidence(id: string, file: string) {
  if (!isInvestigationId(id) || !/^evidence\/call_\d+\.txt$/.test(file)) return null;
  return readFile(join(REPORTS_DIR, id, file), 'utf8').catch(() => null);
}
