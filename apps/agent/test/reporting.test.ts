import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { StepEvent } from '@vic/shared';
import { type Complete, generateReport, quoteFound, validateAnalysis } from '../src/reporting/generate.js';
import { InvestigationRecorder, buildFacts, readEvents } from '../src/reporting/recorder.js';
import type { Analysis } from '../src/reporting/schema.js';
import { runTool } from '../src/tools/events.js';

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
const noPublish = async () => {};

/** A finished investigation: question, two tool calls (one failing), and an answer. */
async function recordInvestigation(base: string) {
  const rec = InvestigationRecorder.start('vc-room-test', base);
  rec.message('user', 'Why are orders failing?');
  const events: StepEvent[] = [];
  const publish = async (e: StepEvent) => void events.push(e);
  await runTool({
    name: 'search_logs',
    args: { service: 'payment' },
    publish,
    record: rec,
    server: 'opensearch',
    run: () => 'Payment request failed. Invalid token. count=42',
  });
  await assert.rejects(
    runTool({
      name: 'query_metrics',
      args: { expr: 'up' },
      publish,
      record: rec,
      run: () => Promise.reject(new Error('boom')),
    }),
  );
  rec.message('assistant', 'Orders fail because payment rejects the token. I saw 42 failures.');
  const facts = await rec.end('participant_disconnected');
  return { rec, facts: facts!, events };
}

const analysis = (overrides: Partial<Analysis> = {}): Analysis => ({
  request: { originalQuestionMsgId: 'msg_001', interpretedObjective: 'Find why orders fail' },
  headline: 'Agent blamed payment token rejection',
  claims: [
    {
      id: 'claim_001',
      msgId: 'msg_002',
      kind: 'root_cause',
      statement: 'Payment rejects the token',
      expressedConfidence: 'certain',
      support: 'supported',
      evidence: [{ callId: 'call_001', quote: 'Invalid token' }],
    },
  ],
  reasoning: [],
  rootCause: { statedByAgent: true, claimId: 'claim_001' },
  limitations: [],
  toolCallNotes: [{ callId: 'call_001', note: 'Found token errors' }],
  ...overrides,
});

test('1. tool calls are recorded in order with real inputs and the same id as the page events', async () => {
  const base = await mkdtemp(join(tmpdir(), 'vic-rep-'));
  const { rec, facts, events } = await recordInvestigation(base);
  assert.deepEqual(
    facts.toolCalls.map((c) => [c.callId, c.seq, c.tool, c.server]),
    [
      ['call_001', 1, 'search_logs', 'opensearch'],
      ['call_002', 2, 'query_metrics', null],
    ],
  );
  assert.deepEqual(facts.toolCalls[0].input, { service: 'payment' });
  const starts = (await readEvents(rec.dir)).filter((e) => e.type === 'tool_start');
  const pageStarts = events.filter((e) => e.type === 'tool_start');
  assert.deepEqual(
    starts.map((s) => (s.type === 'tool_start' ? s.eventId : '')),
    pageStarts.map((e) => e.id),
  );
  assert.equal(
    await readFile(join(rec.dir, 'evidence/call_001.txt'), 'utf8'),
    'Payment request failed. Invalid token. count=42',
  );
});

test('2. failed and timed-out tool calls are recorded with their status', async () => {
  const base = await mkdtemp(join(tmpdir(), 'vic-rep-'));
  const { facts } = await recordInvestigation(base);
  assert.equal(facts.toolCalls[1].status, 'error');
  assert.equal(facts.toolCalls[1].error, 'boom');

  const rec = InvestigationRecorder.start('vc-room-timeout', base);
  await assert.rejects(
    runTool({
      name: 'slow',
      args: {},
      publish: noPublish,
      record: rec,
      timeoutMs: 20,
      run: () => new Promise(() => {}),
    }),
    /timed out/,
  );
  const timed = await rec.end('participant_disconnected');
  assert.equal(timed!.toolCalls[0].status, 'timeout');
  assert.equal(timed!.metrics.timedOutToolCalls, 1);
});

test('3 and 5. made-up references and quotes are removed, and claims left without evidence become unsupported', async () => {
  const base = await mkdtemp(join(tmpdir(), 'vic-rep-'));
  const { facts } = await recordInvestigation(base);
  const evidence = new Map([['call_001', 'Payment request failed. Invalid token. count=42']]);
  const { analysis: checked, corrections } = validateAnalysis(
    analysis({
      claims: [
        {
          id: 'claim_001',
          msgId: 'msg_002',
          kind: 'root_cause',
          statement: 'Payment rejects the token',
          expressedConfidence: 'certain',
          support: 'supported',
          evidence: [
            { callId: 'call_001', quote: 'invalid   TOKEN' },
            { callId: 'call_009', quote: 'anything' },
          ],
        },
        {
          id: 'claim_002',
          msgId: 'msg_002',
          kind: 'impact',
          statement: 'Errors rose 35%',
          expressedConfidence: 'certain',
          support: 'supported',
          evidence: [{ callId: 'call_001', quote: 'rose 35%' }],
        },
      ],
      toolCallNotes: [{ callId: 'call_042', note: 'made up' }],
    }),
    facts,
    evidence,
  );
  assert.equal(checked.claims[0].evidence.length, 1, 'whitespace/case-insensitive quote kept, unknown call removed');
  assert.equal(checked.claims[0].support, 'supported');
  assert.equal(checked.claims[1].support, 'unsupported', 'a claim is kept but downgraded, not dropped');
  assert.equal(checked.claims[1].evidence.length, 0);
  assert.equal(checked.toolCallNotes.length, 0);
  assert.ok(corrections.some((c) => c.includes('call_009')));
  assert.ok(corrections.some((c) => c.includes('claim_002: marked unsupported')));
});

test('4. invalid model output is retried once, then rejected without writing report.json', async () => {
  const base = await mkdtemp(join(tmpdir(), 'vic-rep-'));
  const { rec } = await recordInvestigation(base);
  let calls = 0;
  const bad: Complete = async () => {
    calls += 1;
    return '{"headline": 42}';
  };
  const failed = await generateReport(rec.dir, { complete: bad, model: 'stub' });
  assert.equal(failed.ok, false);
  assert.equal(calls, 2);
  assert.equal(await exists(join(rec.dir, 'report.json')), false);
  assert.match(await readFile(join(rec.dir, 'report.error.json'), 'utf8'), /rejected after 2 attempts/);

  let attempt = 0;
  const fixedOnRetry: Complete = async (_system, user) => {
    attempt += 1;
    if (attempt === 1) return 'not json at all';
    assert.match(user, /previous answer was rejected/);
    return JSON.stringify(analysis());
  };
  const ok = await generateReport(rec.dir, { complete: fixedOnRetry, model: 'stub' });
  assert.equal(ok.ok, true);
  const report = JSON.parse(await readFile(join(rec.dir, 'report.json'), 'utf8'));
  assert.equal(report.analysis.generator.attempts, 2);
  assert.equal(report.facts.metrics.totalToolCalls, 2, 'facts come from the record, not the model');
});

test('6. the record and report stay on disk, and an existing report is not overwritten without force', async () => {
  const base = await mkdtemp(join(tmpdir(), 'vic-rep-'));
  const { rec } = await recordInvestigation(base);
  assert.equal(await exists(join(rec.dir, 'record.json')), true);
  const complete: Complete = async () => JSON.stringify(analysis());
  assert.equal((await generateReport(rec.dir, { complete, model: 'stub' })).ok, true);
  const first = await readFile(join(rec.dir, 'report.json'), 'utf8');
  const again = await generateReport(rec.dir, { complete: async () => 'garbage', model: 'stub' });
  assert.equal(again.skipped, 'report.json already exists');
  assert.equal(await readFile(join(rec.dir, 'report.json'), 'utf8'), first);
});

test('7. reporting failures never throw into the voice session', async () => {
  const blocked = join(await mkdtemp(join(tmpdir(), 'vic-rep-')), 'file');
  await writeFile(blocked, 'not a directory');
  const rec = InvestigationRecorder.start('vc-room-broken', blocked);
  rec.message('user', 'hello');
  const out = await runTool({ name: 't', args: {}, publish: noPublish, record: rec, run: () => 'fine' });
  assert.equal(out, 'fine', 'the tool still works when recording cannot write');
  assert.equal(await rec.end('participant_disconnected'), null);

  const base = await mkdtemp(join(tmpdir(), 'vic-rep-'));
  const { rec: ok } = await recordInvestigation(base);
  const result = await generateReport(ok.dir, {
    complete: () => Promise.reject(new Error('model down')),
    model: 'stub',
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /model down/);
});

test('8. interrupted and crashed investigations are never marked completed', async () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, s)).toISOString();
  const start = { type: 'investigation_start', investigationId: 'inv_x', room: 'r', at: at(0) } as const;
  const question = {
    type: 'message',
    msgId: 'msg_001',
    role: 'user',
    text: 'why?',
    interrupted: false,
    at: at(1),
  } as const;
  const toolStart = {
    type: 'tool_start',
    callId: 'call_001',
    seq: 1,
    eventId: 'e',
    tool: 't',
    server: null,
    input: {},
    at: at(2),
  } as const;
  const toolEnd = {
    type: 'tool_end',
    callId: 'call_001',
    status: 'success',
    durationMs: 5,
    outputChars: 1,
    evidence: null,
    error: null,
    at: at(3),
  } as const;
  const answer = {
    type: 'message',
    msgId: 'msg_002',
    role: 'assistant',
    text: 'because',
    interrupted: false,
    at: at(4),
  } as const;
  const end = { type: 'session_end', reason: 'participant_disconnected', at: at(5) } as const;

  assert.equal(buildFacts([start, question, toolStart, toolEnd, answer, end]).status, 'completed');
  assert.equal(buildFacts([start, question, toolStart, end]).status, 'interrupted', 'hung up during a tool call');
  assert.equal(
    buildFacts([start, question, toolStart, toolEnd, end]).status,
    'interrupted',
    'no answer after the tool',
  );
  assert.equal(
    buildFacts([start, question, toolStart, toolEnd, { ...answer, interrupted: true }, end]).status,
    'interrupted',
    'answer cut off',
  );
  assert.equal(buildFacts([start, question, toolStart, toolEnd, answer]).status, 'incomplete', 'no session_end');
  assert.equal(buildFacts([start, end]).status, 'abandoned');
});

test('secrets are redacted from recorded inputs, outputs and messages', async () => {
  process.env.TEST_REPORT_SECRET_TOKEN = 'sk-live-abcdef123456';
  const base = await mkdtemp(join(tmpdir(), 'vic-rep-'));
  const rec = InvestigationRecorder.start('vc-room-secrets', base);
  rec.message('user', 'my key is sk-live-abcdef123456 and mail me at a.b@example.com');
  await runTool({
    name: 't',
    args: { auth: 'Bearer abc.def.ghi' },
    publish: noPublish,
    record: rec,
    run: () => 'token=hunter2 and sk-live-abcdef123456',
  });
  await rec.end('participant_disconnected');
  const all =
    (await readFile(join(rec.dir, 'events.jsonl'), 'utf8')) +
    (await readFile(join(rec.dir, 'evidence/call_001.txt'), 'utf8'));
  for (const secret of ['sk-live-abcdef123456', 'abc.def.ghi', 'hunter2', 'a.b@example.com']) {
    assert.ok(!all.includes(secret), `${secret} was redacted`);
  }
  delete process.env.TEST_REPORT_SECRET_TOKEN;
});

test('quotes may join exact excerpts with an ellipsis, in order', () => {
  const text = 'errors: product not found: 6e92 / payment request failed. invalid token. / could not charge';
  assert.equal(quoteFound('Product Not Found ... Invalid token', text), true);
  assert.equal(quoteFound('Invalid token … Product Not Found', text), false, 'order matters');
  assert.equal(quoteFound('Product Not Found ... card declined', text), false, 'every excerpt must exist');
});
