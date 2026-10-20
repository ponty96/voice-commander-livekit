import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inference, llm } from '@livekit/agents';
import { z } from 'zod';
import { readEvents, writeFileAtomic } from './recorder.js';
import { buildFacts } from './recorder.js';
import { Analysis, type Facts, REPORT_SCHEMA_VERSION, Report } from './schema.js';

export const REPORT_MODEL = process.env.REPORT_MODEL ?? 'openai/gpt-4.1';
export const PROMPT_VERSION = 'report-v1';
/** How much of each tool call's evidence the report model sees. */
const EVIDENCE_CHARS_PER_CALL = 8000;
const MAX_ATTEMPTS = 2;

/** Sends a system and user prompt to a model and returns its raw text. Injected so tests can stub it. */
export type Complete = (system: string, user: string) => Promise<string>;

/** The report model via LiveKit Inference, constrained to the Analysis JSON schema. */
export function liveKitComplete(model = REPORT_MODEL): Complete {
  const schema = z.toJSONSchema(Analysis, { target: 'draft-7' }) as Record<string, unknown>;
  const reportLlm = new inference.LLM({
    model,
    modelOptions: {
      temperature: 0,
      response_format: { type: 'json_schema', json_schema: { name: 'analysis', schema, strict: false } },
    },
  });
  return async (system, user) => {
    const chatCtx = llm.ChatContext.empty();
    chatCtx.addMessage({ role: 'system', content: system });
    chatCtx.addMessage({ role: 'user', content: user });
    return (await reportLlm.chat({ chatCtx }).collect()).text;
  };
}

const SYSTEM_PROMPT = `You write the analysis part of an incident investigation report.
A voice agent investigated a production problem with tools. You get the facts the application recorded:
the conversation (with msgIds), every tool call (with callIds, inputs and status) and each call's output.

Describe what the AGENT concluded and how well the evidence supports it. Do not investigate yourself,
do not add conclusions the agent did not state, and do not grade the agent.

Rules:
- claims: one entry per distinct thing the agent told the user (finding, root cause, impact, recommendation),
  with the msgId of the assistant message where it said it.
- evidence: only callIds that appear in the facts, each with a quote copied EXACTLY from that call's output.
  Keep quotes short (a phrase or a number with its label). To cite parts of one output, join exact
  excerpts with "...". Never paraphrase inside a quote, and never invent one.
- support: "supported" when the quoted evidence backs the claim, "partially_supported" when it backs part of it
  or the agent derived numbers from it, "unsupported" when no tool output backs it, "contradicted" when the
  evidence says otherwise.
- expressedConfidence: how sure the agent sounded ("certain", "hedged" or "none").
- reasoning: the agent's chain from observation to inference, citing evidence, pointing to the claim it leads to.
- limitations: what the investigation could not determine. acknowledgedByAgent is true only if the agent said it.
- toolCallNotes: one short line per tool call on what it returned.
- If the investigation was interrupted or incomplete, say so in the headline.
Return only the JSON object.`;

/** Keeps the start, any lines that look like errors, and the end of a long tool output. */
function trimEvidence(text: string) {
  if (text.length <= EVIDENCE_CHARS_PER_CALL) return text;
  const head = text.slice(0, 4000);
  const tail = text.slice(-2000);
  const errors = text
    .split('\n')
    .filter((line) => /error|fail|exception|timeout|invalid/i.test(line))
    .join('\n')
    .slice(0, 2000);
  return `${head}\n…\n${errors ? `[lines mentioning errors]\n${errors}\n…\n` : ''}${tail}`;
}

async function readEvidence(dir: string, facts: Facts) {
  const evidence = new Map<string, string>();
  for (const call of facts.toolCalls) {
    if (!call.evidence) continue;
    try {
      evidence.set(call.callId, await readFile(join(dir, call.evidence), 'utf8'));
    } catch {
      // missing evidence file: the call still counts, it just has nothing to quote
    }
  }
  return evidence;
}

function buildUserPrompt(facts: Facts, evidence: Map<string, string>) {
  const { messages, toolCalls, status, closeReason, durationMs } = facts;
  const calls = toolCalls.map(({ callId, tool, server, status: s, input, error }) => ({
    callId,
    tool,
    server,
    status: s,
    input,
    error,
  }));
  const outputs = toolCalls
    .map((c) => `=== ${c.callId} (${c.tool}) ===\n${trimEvidence(evidence.get(c.callId) ?? '(no output recorded)')}`)
    .join('\n\n');
  return [
    `Investigation status: ${status} (session closed: ${closeReason ?? 'unknown'}, ${durationMs ?? '?'} ms).`,
    `Conversation:\n${JSON.stringify(messages, null, 1)}`,
    `Tool calls in order:\n${JSON.stringify(calls, null, 1)}`,
    `Tool outputs:\n${outputs}`,
  ].join('\n\n');
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * True when the quote appears in the evidence. A quote may join excerpts with "..." or "…";
 * each excerpt must then appear, in order. Matching ignores case and whitespace.
 */
export function quoteFound(quote: string, haystack: string) {
  const parts = quote
    .split(/\.{3}|…/)
    .map(normalize)
    .filter(Boolean);
  if (parts.length === 0) return false;
  let from = 0;
  for (const part of parts) {
    const at = haystack.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

/**
 * Checks every reference the model made against the recorded facts. Unknown callIds, msgIds and
 * quotes that don't appear in the evidence are removed, and claims left without evidence become
 * "unsupported". Returns the corrected analysis and a list of what was changed.
 */
export function validateAnalysis(analysis: Analysis, facts: Facts, evidence: Map<string, string>) {
  const corrections: string[] = [];
  const callIds = new Set(facts.toolCalls.map((c) => c.callId));
  const msgRoles = new Map(facts.messages.map((m) => [m.msgId, m.role]));
  const haystacks = new Map([...evidence].map(([id, text]) => [id, normalize(text)]));

  const checkRefs = (refs: Analysis['claims'][number]['evidence'], where: string) =>
    refs.filter((ref) => {
      if (!callIds.has(ref.callId)) {
        corrections.push(`${where}: removed unknown callId ${ref.callId}`);
        return false;
      }
      if (!quoteFound(ref.quote, haystacks.get(ref.callId) ?? '')) {
        corrections.push(`${where}: removed a quote not found in ${ref.callId} ("${ref.quote.slice(0, 80)}")`);
        return false;
      }
      return true;
    });

  const claims = analysis.claims.map((claim) => {
    const evidenceRefs = checkRefs(claim.evidence, claim.id);
    let support = claim.support;
    if (evidenceRefs.length === 0 && (support === 'supported' || support === 'partially_supported')) {
      corrections.push(`${claim.id}: marked unsupported because no valid evidence remained`);
      support = 'unsupported';
    }
    if (msgRoles.get(claim.msgId) !== 'assistant')
      corrections.push(`${claim.id}: msgId ${claim.msgId} is not an agent message`);
    return { ...claim, evidence: evidenceRefs, support };
  });
  const claimIds = new Set(claims.map((c) => c.id));

  const reasoning = analysis.reasoning.map((step, i) => {
    const leadsTo = step.leadsTo && claimIds.has(step.leadsTo) ? step.leadsTo : null;
    if (step.leadsTo && !leadsTo) corrections.push(`reasoning ${i + 1}: removed unknown claim ${step.leadsTo}`);
    return { ...step, evidence: checkRefs(step.evidence, `reasoning ${i + 1}`), leadsTo };
  });

  const rootClaim = analysis.rootCause.claimId;
  const rootCause = {
    ...analysis.rootCause,
    claimId: rootClaim && claimIds.has(rootClaim) ? rootClaim : null,
  };
  if (rootClaim && !rootCause.claimId) corrections.push(`rootCause: removed unknown claim ${rootClaim}`);

  const question = analysis.request.originalQuestionMsgId;
  const request = {
    ...analysis.request,
    originalQuestionMsgId: question && msgRoles.get(question) === 'user' ? question : null,
  };
  if (question && !request.originalQuestionMsgId) corrections.push(`request: ${question} is not a user message`);

  const toolCallNotes = analysis.toolCallNotes.filter((n) => {
    if (callIds.has(n.callId)) return true;
    corrections.push(`toolCallNotes: removed unknown callId ${n.callId}`);
    return false;
  });

  return { analysis: { ...analysis, request, claims, reasoning, rootCause, toolCallNotes }, corrections };
}

function parseJson(text: string) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  return JSON.parse(trimmed) as unknown;
}

export interface GenerateResult {
  ok: boolean;
  skipped?: string;
  error?: string;
}

/**
 * Generates report.json for one investigation folder from its record. Never throws: a failure is
 * written to report.error.json and returned. Existing reports are kept unless `force` is set.
 */
export async function generateReport(
  dir: string,
  { complete, model = REPORT_MODEL, force = false }: { complete?: Complete; model?: string; force?: boolean } = {},
): Promise<GenerateResult> {
  const reportPath = join(dir, 'report.json');
  const errorPath = join(dir, 'report.error.json');
  let attempts = 0;
  try {
    if (!force && (await exists(reportPath))) return { ok: true, skipped: 'report.json already exists' };
    const facts = buildFacts(await readEvents(dir));
    if (facts.status === 'abandoned') return { ok: true, skipped: 'nothing was asked' };

    const evidence = await readEvidence(dir, facts);
    const ask = complete ?? liveKitComplete(model);
    const user = buildUserPrompt(facts, evidence);
    let feedback = '';
    let parsed: Analysis | undefined;
    let lastError = '';
    while (attempts < MAX_ATTEMPTS && !parsed) {
      attempts += 1;
      const raw = await ask(SYSTEM_PROMPT, feedback ? `${user}\n\n${feedback}` : user);
      try {
        const result = Analysis.safeParse(parseJson(raw));
        if (result.success) parsed = result.data;
        else lastError = z.prettifyError(result.error);
      } catch (err) {
        lastError = `not valid JSON: ${(err as Error).message}`;
      }
      if (!parsed) feedback = `Your previous answer was rejected:\n${lastError}\nReturn a corrected JSON object.`;
    }
    if (!parsed) throw new Error(`model output rejected after ${attempts} attempts: ${lastError}`);

    const { analysis, corrections } = validateAnalysis(parsed, facts, evidence);
    const report = Report.parse({
      schemaVersion: REPORT_SCHEMA_VERSION,
      facts,
      analysis: {
        ...analysis,
        generator: { model, promptVersion: PROMPT_VERSION, generatedAt: new Date().toISOString(), attempts },
        validation: corrections,
      },
    });
    await writeFileAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[report] wrote ${reportPath} (${corrections.length} corrections)`);
    return { ok: true };
  } catch (err) {
    const error = (err as Error).message;
    console.error(`[report] ${dir}: ${error}`);
    try {
      await writeFileAtomic(
        errorPath,
        `${JSON.stringify({ at: new Date().toISOString(), model, attempts, error }, null, 2)}\n`,
      );
    } catch {
      // nothing more we can do; the record is still on disk
    }
    return { ok: false, error };
  }
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
