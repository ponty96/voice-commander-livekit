import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { parseSpans, summarizeTrace, summarizeTraces } from '../src/integrations/jaeger.js';
import { defineTool } from '../src/tools/define.js';
import { customToolKnowledge } from '../src/tools/index.js';

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const span = (traceId: string, spanId: string, parentSpanId: string, name: string, extra: object = {}) => ({
  traceId,
  spanId,
  parentSpanId,
  name,
  kind: 2,
  startTimeUnixNano: '1792444840000000000',
  endTimeUnixNano: '1792444840050000000',
  ...extra,
});
const body = {
  result: {
    resourceSpans: [
      {
        resource: { attributes: [str('service.name', 'checkout')] },
        scopeSpans: [
          {
            spans: [
              span('t1', 'a', '', 'PlaceOrder', {
                attributes: [str('user.id', 'u1'), str('http.method', 'POST')],
                status: { code: 2 },
                events: [{ name: 'exception', attributes: [str('exception.message', 'could not charge')] }],
              }),
              span('t2', 'x', '', 'PlaceOrder', { attributes: [str('user.id', 'u2')] }),
            ],
          },
        ],
      },
      {
        resource: { attributes: [str('service.name', 'product-catalog')] },
        scopeSpans: [
          {
            spans: [
              span('t1', 'b', 'a', 'GetProduct', { attributes: [str('product.name', 'Telescope')] }),
              span('t2', 'y', 'x', 'GetProduct', { attributes: [str('product.name', 'Telescope')] }),
            ],
          },
        ],
      },
    ],
  },
};

test('parses OTLP spans with service, duration, error message and attributes', () => {
  const spans = parseSpans(body);
  assert.equal(spans.length, 4);
  const root = spans.find((s) => s.spanId === 'a')!;
  assert.equal(root.service, 'checkout');
  assert.equal(root.kind, 'server');
  assert.equal(root.durationMs, 50);
  assert.equal(root.error, 'could not charge');
});

test('summarizes traces with errors, business attributes (no transport noise) and a tally', () => {
  const text = summarizeTraces(parseSpans(body), 10);
  assert.match(text, /^2 traces matched/);
  assert.match(text, /errors: could not charge \(in checkout "PlaceOrder"\)/);
  assert.match(text, /product\.name=Telescope/);
  assert.doesNotMatch(text, /http\.method/);
  assert.match(text, /- product\.name: Telescope \(2\)/);
});

test('renders one trace as a span tree', () => {
  const text = summarizeTrace(parseSpans(body).filter((s) => s.traceId === 't1'));
  assert.match(text, /- checkout "PlaceOrder" \(server, 50 ms\) ERROR: could not charge/);
  assert.match(text, /\n {2}- product-catalog "GetProduct"/);
});

test('custom tools that share a knowledgeFile get one instructions section', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vic-know-'));
  await writeFile(join(dir, 'traces.md'), 'Discover first.\n');
  const tool = (name: string, knowledgeFile?: string) =>
    defineTool({ name, description: name, parameters: z.object({}), execute: () => '', knowledgeFile });
  const text = customToolKnowledge([tool('a', 'traces.md'), tool('b', 'traces.md'), tool('c')], dir);
  assert.equal(text, '## How to use a, b\n\nDiscover first.');
});
