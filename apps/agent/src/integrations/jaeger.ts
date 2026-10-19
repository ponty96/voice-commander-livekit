/**
 * A small client for Jaeger's v3 query API (OTLP JSON), plus summarizers that turn raw spans
 * into short text the LLM can read. A raw trace is dozens of deeply nested spans; the agent
 * only gets the summaries.
 */

const TIMEOUT_MS = 15_000;
/** Attribute prefixes that are transport detail, not what the request was about. */
const NOISE = [
  'http.',
  'net.',
  'network.',
  'rpc.',
  'server.',
  'client.',
  'url.',
  'user_agent.',
  'thread.',
  'code.',
  'otel.',
  'process.',
  'telemetry.',
  'host.',
  'os.',
  'grpc.',
  'component',
  'upstream',
  'downstream',
  'peer.',
  'node_id',
  'zone',
  'guid',
  'response_',
  'request_',
  'internal.',
  'original_span_name',
  'next.',
  'db.query',
  'db.statement',
  'messaging.',
  'error',
  'user_agent',
  'db.',
  'feature_flag.',
  'sinatra.',
];
const MAX_VALUE = 80;
const MAX_VALUES_PER_KEY = 6;

const KIND = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'];

interface OtlpValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}
interface OtlpAttr {
  key: string;
  value: OtlpValue;
}
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpAttr[];
  events?: { name: string; attributes?: OtlpAttr[] }[];
  status?: { code?: number; message?: string };
}
interface OtlpResult {
  result?: {
    resourceSpans?: { resource: { attributes: OtlpAttr[] }; scopeSpans: { spans: OtlpSpan[] }[] }[];
  };
}

/** One span with the fields the summaries use. */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  service: string;
  name: string;
  kind: string;
  startMs: number;
  durationMs: number;
  error?: string;
  attributes: Record<string, string>;
}

const valueOf = (v: OtlpValue) => String(v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? '');
const clip = (s: string) => (s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s);
const isNoise = (key: string) => NOISE.some((p) => key.startsWith(p));
const time = (ms: number) => new Date(ms).toISOString().slice(11, 19);

function baseUrl() {
  const url = process.env.JAEGER_URL;
  if (!url) throw new Error('JAEGER_URL is not set, so traces are unavailable.');
  return `${url.replace(/\/$/, '')}/api/v3`;
}

async function get(path: string, params: Record<string, string | undefined> = {}) {
  const url = new URL(`${baseUrl()}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  // Jaeger answers 404 when a search matches nothing.
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`Jaeger returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Flattens Jaeger's OTLP JSON into spans. Exported for tests. */
export function parseSpans(body: OtlpResult): Span[] {
  const spans: Span[] = [];
  for (const rs of body.result?.resourceSpans ?? []) {
    const service = valueOf(rs.resource.attributes.find((a) => a.key === 'service.name')?.value ?? {}) || 'unknown';
    for (const ss of rs.scopeSpans) {
      for (const s of ss.spans) {
        const attributes: Record<string, string> = {};
        for (const a of s.attributes ?? []) attributes[a.key] = valueOf(a.value);
        const exception = s.events
          ?.find((e) => e.name === 'exception')
          ?.attributes?.find((a) => a.key === 'exception.message');
        const failed = s.status?.code === 2;
        const startMs = Number(BigInt(s.startTimeUnixNano) / 1_000_000n);
        spans.push({
          traceId: s.traceId,
          spanId: s.spanId,
          parentSpanId: s.parentSpanId || undefined,
          service,
          name: s.name,
          kind: KIND.at(s.kind ?? 0) ?? 'unspecified',
          startMs,
          durationMs: Number(BigInt(s.endTimeUnixNano) / 1_000_000n) - startMs,
          error: failed
            ? clip(exception ? valueOf(exception.value) : s.status?.message || attributes['error.type'] || 'error')
            : undefined,
          attributes,
        });
      }
    }
  }
  return spans;
}

/** The attributes that describe what a request was about (products, users, amounts…), minus transport noise. */
function businessAttributes(spans: Span[]) {
  const values = new Map<string, Set<string>>();
  for (const s of spans) {
    for (const [k, v] of Object.entries(s.attributes)) {
      if (isNoise(k) || v === '') continue;
      if (!values.has(k)) values.set(k, new Set());
      values.get(k)!.add(clip(v));
    }
  }
  return values;
}

function formatAttributes(values: Map<string, Set<string>>) {
  return [...values.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => {
      const list = [...v];
      const more = list.length > MAX_VALUES_PER_KEY ? ` (+${list.length - MAX_VALUES_PER_KEY} more)` : '';
      return `${k}=${list.slice(0, MAX_VALUES_PER_KEY).join(' | ')}${more}`;
    })
    .join('; ');
}

/** Groups failing spans by message, so one failure that propagates up the call chain reads once. */
function formatErrors(errors: Span[]) {
  const byMessage = new Map<string, string[]>();
  for (const s of errors) byMessage.set(s.error!, [...(byMessage.get(s.error!) ?? []), `${s.service} "${s.name}"`]);
  return [...byMessage.entries()].map(([message, where]) => `${message} (in ${where.join(', ')})`).join(' / ');
}

/** One line per trace plus a tally of attribute values across all of them. Exported for tests. */
export function summarizeTraces(spans: Span[], limit: number) {
  const byTrace = new Map<string, Span[]>();
  for (const s of spans) byTrace.set(s.traceId, [...(byTrace.get(s.traceId) ?? []), s]);
  if (byTrace.size === 0) return 'No traces matched.';

  const traces = [...byTrace.values()]
    .map((list) => {
      const ids = new Set(list.map((s) => s.spanId));
      const root = list.find((s) => !s.parentSpanId || !ids.has(s.parentSpanId)) ?? list[0];
      return { list, root, start: Math.min(...list.map((s) => s.startMs)) };
    })
    .sort((a, b) => b.start - a.start)
    .slice(0, limit);

  const tally = new Map<string, Map<string, number>>();
  const lines = traces.map(({ list, root, start }, i) => {
    const attrs = businessAttributes(list);
    for (const [k, vs] of attrs) {
      if (!tally.has(k)) tally.set(k, new Map());
      for (const v of vs) tally.get(k)!.set(v, (tally.get(k)!.get(v) ?? 0) + 1);
    }
    const errors = list.filter((s) => s.error);
    const services = [...new Set(list.map((s) => s.service))].join(', ');
    return [
      `${i + 1}. trace ${root.traceId} started ${time(start)} UTC, ${root.durationMs} ms, ${list.length} spans, root ${root.service} "${root.name}"`,
      `   services: ${services}`,
      errors.length ? `   errors: ${formatErrors(errors)}` : '   errors: none',
      `   attributes: ${formatAttributes(attrs) || 'none'}`,
    ].join('\n');
  });

  const common = [...tally.entries()]
    .filter(([, counts]) => counts.size > 1 || [...counts.values()][0] > 1)
    .map(([k, counts]) => {
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_VALUES_PER_KEY);
      return `${k}: ${top.map(([v, n]) => `${v} (${n})`).join(', ')}`;
    })
    .sort();

  // The tally goes first: it answers "which ones / how many" without reading every trace.
  return [
    `${byTrace.size} traces matched, summarizing the ${traces.length} most recent.`,
    common.length ? `Across these traces (value: number of traces):\n${common.map((c) => `- ${c}`).join('\n')}` : '',
    'Traces, newest first:',
    ...lines,
  ]
    .filter(Boolean)
    .join('\n');
}

/** A trace as an indented span tree, one line per span. Exported for tests. */
export function summarizeTrace(spans: Span[], maxSpans = 80) {
  if (spans.length === 0) return 'Trace not found.';
  const children = new Map<string | undefined, Span[]>();
  const ids = new Set(spans.map((s) => s.spanId));
  for (const s of spans) {
    const parent = s.parentSpanId && ids.has(s.parentSpanId) ? s.parentSpanId : undefined;
    children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  const lines: string[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const s of (children.get(parent) ?? []).sort((a, b) => a.startMs - b.startMs)) {
      if (lines.length >= maxSpans) return;
      const attrs = formatAttributes(businessAttributes([s]));
      lines.push(
        `${'  '.repeat(depth)}- ${s.service} "${s.name}" (${s.kind}, ${s.durationMs} ms)` +
          (s.error ? ` ERROR: ${s.error}` : '') +
          (attrs ? ` [${attrs}]` : ''),
      );
      walk(s.spanId, depth + 1);
    }
  };
  walk(undefined, 0);
  const more = spans.length > lines.length ? `\n(${spans.length - lines.length} more spans not shown)` : '';
  return `Trace ${spans[0].traceId}, ${spans.length} spans:\n${lines.join('\n')}${more}`;
}

/** Services that sent traces, or one service's operations grouped by span kind. */
export async function listTraceOperations(service?: string) {
  if (!service) {
    const { services = [] } = (await get('/services')) as { services?: string[] };
    return `Services with traces: ${[...services].sort().join(', ')}`;
  }
  const { operations = [] } = (await get('/operations', { service })) as {
    operations?: { name: string; spanKind: string }[];
  };
  if (operations.length === 0) return `No operations found for ${service}.`;
  const byKind = new Map<string, string[]>();
  for (const op of operations) {
    const kind = op.spanKind || 'unspecified';
    byKind.set(kind, [...(byKind.get(kind) ?? []), op.name]);
  }
  return [`Operations of ${service} by span kind (server = requests it handles, client = calls it makes):`]
    .concat([...byKind.entries()].map(([kind, names]) => `- ${kind}: ${names.sort().join(', ')}`))
    .join('\n');
}

export interface SearchTracesInput {
  service: string;
  operation?: string | null;
  errorsOnly?: boolean | null;
  attributes?: Record<string, string> | null;
  minDurationMs?: number | null;
  lookbackMinutes?: number | null;
  limit?: number | null;
}

export async function searchTraces(input: SearchTracesInput) {
  const now = Date.now();
  const lookback = input.lookbackMinutes ?? 15;
  const limit = Math.min(input.limit ?? 10, 20);
  const attributes = { ...(input.attributes ?? {}), ...(input.errorsOnly ? { error: 'true' } : {}) };
  const body = (await get('/traces', {
    'query.service_name': input.service,
    'query.operation_name': input.operation ?? undefined,
    'query.start_time_min': new Date(now - lookback * 60_000).toISOString(),
    'query.start_time_max': new Date(now).toISOString(),
    'query.attributes': Object.keys(attributes).length ? JSON.stringify(attributes) : undefined,
    'query.duration_min': input.minDurationMs ? `${input.minDurationMs}ms` : undefined,
    'query.search_depth': String(limit),
  })) as OtlpResult;
  return summarizeTraces(parseSpans(body), limit);
}

export async function getTrace(traceId: string) {
  return summarizeTrace(parseSpans((await get(`/traces/${encodeURIComponent(traceId)}`)) as OtlpResult));
}
