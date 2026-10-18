import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StepEvent } from '@vic/shared';
import { createRedactor, runTool } from '../src/tools/events.js';

function recorder() {
  const events: StepEvent[] = [];
  return { events, publish: async (e: StepEvent) => void events.push(e) };
}

test('publishes tool_start and tool_end with the same id and the real output', async () => {
  const { events, publish } = recorder();
  const out = await runTool({
    name: 'lookup',
    args: { service: 'checkout', n: 2 },
    publish,
    run: async () => ({ ok: 1 }),
  });

  assert.equal(out, '{"ok":1}');
  assert.deepEqual(
    events.map((e) => e.type),
    ['tool_start', 'tool_end'],
  );
  const [start, end] = events;
  assert.equal(start.id, end.id);
  assert.ok(start.type === 'tool_start' && start.name === 'lookup' && start.input === 'service=checkout n=2');
  assert.ok(end.type === 'tool_end' && end.output === '{"ok":1}' && end.error === false);
  assert.ok(typeof start.at === 'number' && typeof end.at === 'number');
});

test('publishes tool_end with error: true and rethrows when the tool fails', async () => {
  const { events, publish } = recorder();
  await assert.rejects(
    runTool({ name: 'boom', args: {}, publish, run: () => Promise.reject(new Error('no route')) }),
    /no route/,
  );
  const end = events[1];
  assert.ok(end.type === 'tool_end' && end.error === true && end.output === 'no route');
  assert.equal(events[0].id, end.id);
});

test('a failing publisher does not fail the tool', async () => {
  const out = await runTool({
    name: 'ok',
    args: {},
    publish: () => Promise.reject(new Error('room gone')),
    run: () => 'fine',
  });
  assert.equal(out, 'fine');
});

test('redacts secret values from input and output', async () => {
  const { events, publish } = recorder();
  const redact = createRedactor(['s3cr3t-token']);
  await runTool({ name: 't', args: { q: 'x s3cr3t-token' }, publish, redact, run: () => 'got s3cr3t-token' });
  assert.ok(events[0].type === 'tool_start' && events[0].input === 'q=x ***');
  assert.ok(events[1].type === 'tool_end' && events[1].output === 'got ***');
});
