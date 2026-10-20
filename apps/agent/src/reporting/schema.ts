import { z } from 'zod';

/**
 * Investigation reporting formats. Three layers, written by three different things:
 * - events.jsonl / record.json: application facts, written by code during and after the call.
 * - report.json: those facts plus `analysis`, the only part an LLM writes.
 * - evaluation.json: added later outside the agent. The agent never reads it.
 */

export const REPORT_SCHEMA_VERSION = '1.0';
export const EVALUATION_SCHEMA_VERSION = 'eval-1.0';

// ---- events.jsonl: one line per event, append-only ----

export type RecordEvent =
  | { type: 'investigation_start'; investigationId: string; room: string; at: string }
  | { type: 'config'; llm: string; instructionsHash: string; tools: string[]; at: string }
  | { type: 'message'; msgId: string; role: 'user' | 'assistant'; text: string; interrupted: boolean; at: string }
  | {
      type: 'tool_start';
      callId: string;
      seq: number;
      eventId: string;
      tool: string;
      server: string | null;
      input: unknown;
      at: string;
    }
  | {
      type: 'tool_end';
      callId: string;
      status: ToolCallStatus;
      durationMs: number;
      outputChars: number;
      evidence: string | null;
      error: string | null;
      at: string;
    }
  | { type: 'session_end'; reason: string; at: string };

export type ToolCallStatus = 'success' | 'error' | 'timeout';

// ---- record.json: the facts, built by code from events.jsonl ----

export const InvestigationStatus = z.enum(['completed', 'interrupted', 'abandoned', 'incomplete']);

export const ToolCallFacts = z.object({
  callId: z.string(),
  seq: z.number(),
  tool: z.string(),
  server: z.string().nullable(),
  startedAt: z.string(),
  durationMs: z.number().nullable(),
  status: z.enum(['success', 'error', 'timeout', 'unfinished']),
  input: z.unknown(),
  outputChars: z.number().nullable(),
  evidence: z.string().nullable(),
  error: z.string().nullable(),
});

export const Facts = z.object({
  investigationId: z.string(),
  room: z.string(),
  status: InvestigationStatus,
  closeReason: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  agent: z.object({ llm: z.string().nullable(), configHash: z.string().nullable() }),
  messages: z.array(
    z.object({
      msgId: z.string(),
      role: z.enum(['user', 'assistant']),
      at: z.string(),
      text: z.string(),
      interrupted: z.boolean(),
    }),
  ),
  toolCalls: z.array(ToolCallFacts),
  metrics: z.object({
    totalToolCalls: z.number(),
    successfulToolCalls: z.number(),
    failedToolCalls: z.number(),
    timedOutToolCalls: z.number(),
    uniqueToolsUsed: z.number(),
    repeatedToolCalls: z.number(),
    totalToolExecutionMs: z.number(),
    timeToFirstToolCallMs: z.number().nullable(),
    timeToFirstAgentConclusionMs: z.number().nullable(),
  }),
});
export type Facts = z.infer<typeof Facts>;

// ---- analysis: the only part an LLM writes ----

const EvidenceRef = z.object({
  callId: z.string().describe('A callId from facts.toolCalls'),
  quote: z.string().describe("Exact text copied from that call's evidence"),
});

export const Analysis = z.object({
  request: z.object({
    originalQuestionMsgId: z.string().nullable().describe('msgId of the user message that started the investigation'),
    interpretedObjective: z.string(),
  }),
  headline: z.string().describe('One sentence: what the agent concluded, or that it reached no conclusion'),
  claims: z.array(
    z.object({
      id: z.string().describe('claim_001, claim_002, ...'),
      msgId: z.string().describe('msgId of the assistant message where the agent said this'),
      kind: z.enum(['finding', 'root_cause', 'impact', 'recommendation', 'other']),
      statement: z.string().describe('What the agent claimed, in one sentence'),
      expressedConfidence: z.enum(['certain', 'hedged', 'none']).describe('How sure the agent sounded'),
      support: z.enum(['supported', 'partially_supported', 'unsupported', 'contradicted']),
      evidence: z.array(EvidenceRef),
    }),
  ),
  reasoning: z.array(
    z.object({
      observation: z.string(),
      evidence: z.array(EvidenceRef),
      inference: z.string(),
      leadsTo: z.string().nullable().describe('claim id this step supports, or null'),
    }),
  ),
  rootCause: z.object({
    statedByAgent: z.boolean(),
    claimId: z.string().nullable(),
  }),
  limitations: z.array(z.object({ statement: z.string(), acknowledgedByAgent: z.boolean() })),
  toolCallNotes: z.array(z.object({ callId: z.string(), note: z.string() })),
});
export type Analysis = z.infer<typeof Analysis>;

export const Report = z.object({
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  facts: Facts,
  analysis: Analysis.extend({
    generator: z.object({
      model: z.string(),
      promptVersion: z.string(),
      generatedAt: z.string(),
      attempts: z.number(),
    }),
    validation: z.array(z.string()).describe('Corrections code made to the model output'),
  }),
});
export type Report = z.infer<typeof Report>;

// ---- evaluation.json: written outside the agent ----

export const Evaluation = z.object({
  schemaVersion: z.literal(EVALUATION_SCHEMA_VERSION),
  investigationId: z.string(),
  scenario: z.object({
    id: z.string(),
    injectedAt: z.string().nullable(),
    flag: z.string().nullable(),
    expectedRootCause: z.string().nullable(),
    expectedEvidence: z.array(z.string()),
  }),
  judgement: z.object({
    rootCauseCorrect: z.boolean().nullable(),
    evidenceQuality: z.number().nullable(),
    completeness: z.number().nullable(),
    missedEvidence: z.array(z.string()),
    unsupportedClaims: z.array(z.string()),
    notes: z.string().nullable(),
  }),
  judgedBy: z.string(),
});
export type Evaluation = z.infer<typeof Evaluation>;
