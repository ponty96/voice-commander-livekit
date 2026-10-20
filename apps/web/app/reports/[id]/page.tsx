import Link from 'next/link';
import { notFound } from 'next/navigation';
import { type ToolCall, getInvestigation, readEvidence } from '@/lib/reports';
import { cn } from '@/lib/utils';
import { RefreshWhile } from '../refresh';

export const dynamic = 'force-dynamic';

const SUPPORT_STYLE: Record<string, string> = {
  supported: 'border-ok-line text-ok',
  partially_supported: 'border-line text-ink-soft',
  unsupported: 'border-danger text-danger-ink',
  contradicted: 'border-danger text-danger-ink',
};

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-panel p-5">
      <h2 className="m-0 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

async function ToolCallRow({ id, call, note }: { id: string; call: ToolCall; note?: string }) {
  const evidence = call.evidence ? await readEvidence(id, call.evidence) : null;
  return (
    <li id={call.callId} className="flex flex-col gap-1 border-t border-line py-3 first:border-t-0">
      <div className="flex flex-wrap justify-between gap-2">
        <span className="font-mono text-[13px]">
          {call.callId} · {call.tool}
        </span>
        <span className={cn('font-mono text-xs', call.status === 'success' ? 'text-muted' : 'text-danger-ink')}>
          {call.status} · {call.durationMs ?? '-'} ms
        </span>
      </div>
      <code className="font-mono text-xs break-all text-muted">{JSON.stringify(call.input)}</code>
      {note && <span className="text-sm text-ink-soft">{note}</span>}
      {call.error && <span className="text-sm text-danger-ink">{call.error}</span>}
      {evidence && (
        <details>
          <summary className="cursor-pointer text-xs text-muted">Output ({evidence.length} chars)</summary>
          <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-ground p-3 text-xs whitespace-pre-wrap">
            {evidence}
          </pre>
        </details>
      )}
    </li>
  );
}

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const inv = await getInvestigation(id);
  if (!inv) notFound();
  const { facts, analysis, reportError } = inv;
  const pending = !analysis && !reportError && facts?.status !== 'abandoned';
  const notes = new Map(analysis?.toolCallNotes.map((n) => [n.callId, n.note]));

  return (
    <main className="mx-auto box-border flex w-full max-w-[1100px] flex-col gap-5 p-4 sm:p-6">
      <RefreshWhile active={pending} />
      <header className="flex flex-col gap-2">
        <Link href="/reports" className="text-sm text-muted hover:text-ink">
          ← All reports
        </Link>
        <h1 className="m-0 text-2xl font-semibold">{analysis?.headline ?? 'Investigation'}</h1>
        <p className="m-0 font-mono text-xs text-muted">
          {id}
          {facts &&
            ` · ${facts.status} · ${Math.round((facts.durationMs ?? 0) / 1000)}s · ${facts.toolCalls.length} tool calls`}
        </p>
        <a href={`/api/reports/${id}`} download className="w-fit text-sm text-accent hover:underline">
          Download JSON
        </a>
      </header>

      {!facts && <p className="text-muted">The call is still in progress. This page updates when it ends.</p>}
      {facts && pending && <p className="text-muted">Generating the report. This page updates when it's ready.</p>}
      {reportError && <p className="text-danger-ink">Report generation failed: {reportError}</p>}

      {analysis && (
        <Section title="What the agent claimed">
          <p className="m-0 text-sm text-muted">Objective: {analysis.request.interpretedObjective}</p>
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {analysis.claims.map((c) => (
              <li key={c.id} className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={cn('rounded-full border px-2 py-0.5', SUPPORT_STYLE[c.support])}>
                    {c.support.replace('_', ' ')}
                  </span>
                  <span className="text-muted">
                    {c.kind.replace('_', ' ')} · sounded {c.expressedConfidence} · {c.msgId}
                    {analysis.rootCause.claimId === c.id && ' · root cause'}
                  </span>
                </div>
                <span>{c.statement}</span>
                {c.evidence.map((e, i) => (
                  <a key={i} href={`#${e.callId}`} className="text-sm text-ink-soft hover:text-ink">
                    <span className="font-mono text-xs text-accent">{e.callId}</span> “{e.quote}”
                  </a>
                ))}
              </li>
            ))}
            {analysis.claims.length === 0 && <li className="text-muted">The agent made no claims.</li>}
          </ul>
        </Section>
      )}

      {analysis && analysis.limitations.length > 0 && (
        <Section title="Limitations">
          <ul className="m-0 flex flex-col gap-1 pl-5">
            {analysis.limitations.map((l, i) => (
              <li key={i}>
                {l.statement}
                <span className="text-xs text-muted">
                  {l.acknowledgedByAgent ? ' (said by the agent)' : ' (not said)'}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {facts && (
        <Section title="Tool calls, in order">
          <ol className="m-0 list-none p-0">
            {facts.toolCalls.map((c) => (
              <ToolCallRow key={c.callId} id={id} call={c} note={notes.get(c.callId)} />
            ))}
            {facts.toolCalls.length === 0 && <li className="text-muted">No tools were called.</li>}
          </ol>
        </Section>
      )}

      {facts && (
        <Section title="Conversation">
          <ol className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
            {facts.messages.map((m) => (
              <li key={m.msgId} id={m.msgId}>
                <span className="font-mono text-xs text-muted">
                  {m.msgId} · {time(m.at)} · {m.role === 'user' ? 'You' : 'Commander'}
                  {m.interrupted && ' · interrupted'}
                </span>
                <p className="m-0">{m.text}</p>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {analysis && analysis.validation.length > 0 && (
        <Section title="Corrections made to the report model's output">
          <ul className="m-0 flex flex-col gap-1 pl-5 text-sm text-muted">
            {analysis.validation.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        </Section>
      )}
    </main>
  );
}
