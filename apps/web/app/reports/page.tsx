import Link from 'next/link';
import { type Investigation, listInvestigations } from '@/lib/reports';
import { cn } from '@/lib/utils';
import { RefreshWhile } from './refresh';

export const dynamic = 'force-dynamic';

const seconds = (ms: number | null | undefined) => (ms == null ? '-' : `${Math.round(ms / 1000)}s`);

function state(i: Investigation) {
  if (i.analysis) return 'report ready';
  if (i.reportError) return 'report failed';
  if (!i.facts) return 'call in progress';
  if (i.facts.status === 'abandoned') return 'no question asked';
  return 'generating report';
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ room?: string }> }) {
  const { room } = await searchParams;
  const investigations = await listInvestigations();
  const waiting = investigations.some((i) => ['call in progress', 'generating report'].includes(state(i)));

  return (
    <main className="mx-auto box-border flex w-full max-w-[1100px] flex-col gap-6 p-4 sm:p-6">
      <RefreshWhile active={waiting} />
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold tracking-[0.08em] text-accent uppercase">
            Voice Incident Commander
          </span>
          <h1 className="m-0 text-2xl font-semibold">Investigation reports</h1>
        </div>
        <Link href="/" className="text-sm text-muted hover:text-ink">
          New call
        </Link>
      </header>

      {investigations.length === 0 ? (
        <p className="text-muted">No investigations yet. Reports appear here after each call.</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-panel">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="text-muted">
              <tr>
                {['Started', 'Room', 'Status', 'Duration', 'Tool calls', 'Headline'].map((h) => (
                  <th key={h} className="border-b border-line px-4 py-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {investigations.map((i) => (
                <tr key={i.id} className={cn('align-top', room && i.facts?.room === room && 'bg-running')}>
                  <td className="border-b border-line px-4 py-3 font-mono text-xs whitespace-nowrap">
                    <Link href={`/reports/${i.id}`} className="text-accent hover:underline">
                      {i.facts ? new Date(i.facts.startedAt).toLocaleString() : i.id}
                    </Link>
                  </td>
                  <td className="border-b border-line px-4 py-3 font-mono text-xs">{i.facts?.room ?? '-'}</td>
                  <td className="border-b border-line px-4 py-3 whitespace-nowrap">
                    {i.facts?.status ?? '-'}
                    <div className="text-xs text-muted">{state(i)}</div>
                  </td>
                  <td className="border-b border-line px-4 py-3">{seconds(i.facts?.durationMs)}</td>
                  <td className="border-b border-line px-4 py-3">{i.facts?.toolCalls.length ?? '-'}</td>
                  <td className="border-b border-line px-4 py-3">{i.analysis?.headline ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
