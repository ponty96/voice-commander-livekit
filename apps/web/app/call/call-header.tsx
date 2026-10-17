'use client';

import { useEffect, useState } from 'react';
import { ConnectionState } from 'livekit-client';
import { useSessionContext } from '@livekit/components-react';
import { cn } from '@/lib/utils';

function useElapsed(running: boolean) {
  const [start, setStart] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setStart((s) => s ?? Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const secs = start ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
  return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
}

const CONNECTION_LABEL: Partial<Record<ConnectionState, string>> = {
  [ConnectionState.Connected]: 'Connected',
  [ConnectionState.Connecting]: 'Connecting',
  [ConnectionState.Reconnecting]: 'Reconnecting',
  [ConnectionState.SignalReconnecting]: 'Reconnecting',
  [ConnectionState.Disconnected]: 'Disconnected',
};

export function CallHeader() {
  const session = useSessionContext();
  const connected = session.connectionState === ConnectionState.Connected;
  const elapsed = useElapsed(session.isConnected);

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-semibold tracking-[0.08em] text-accent uppercase">Voice Incident Commander</span>
        <span className="font-mono text-[15px]">{session.room.name || '...'}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="font-mono text-sm text-muted">{elapsed}</span>
        <span
          className={cn(
            'inline-flex items-center gap-2 rounded-full border px-3 py-[5px] text-[13px]',
            connected ? 'border-ok-line text-ok' : 'border-line text-muted',
          )}
        >
          <span className={cn('size-2 rounded-full', connected ? 'bg-ok' : 'animate-pulse-soft bg-muted')} />
          {CONNECTION_LABEL[session.connectionState] ?? session.connectionState}
        </span>
      </div>
    </header>
  );
}
