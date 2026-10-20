'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TokenSource } from 'livekit-client';
import { RoomAudioRenderer, RoomContext, SessionProvider, StartAudio, useSession } from '@livekit/components-react';
import type { TokenResponse } from '@vic/shared';
import { AgentStepsProvider } from './use-agent-steps';
import { CallHeader } from './call-header';
import { Conversation } from './conversation';
import { VoicePanel } from './voice-panel';

export default function CallPage() {
  const router = useRouter();
  const tokenSource = useMemo(
    () =>
      TokenSource.literal(async () => {
        const res = await fetch('/api/token', { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Failed to get a token');
        const { serverUrl, participantToken } = data as TokenResponse;
        return { serverUrl, participantToken };
      }),
    [],
  );
  const session = useSession(tokenSource);
  const [micError, setMicError] = useState<string | null>(null);

  useEffect(() => {
    session.start({ tracks: { microphone: { enabled: true } } }).catch((err: Error) => {
      setMicError(
        err.name === 'NotAllowedError'
          ? 'Microphone access is blocked. Allow it in your browser, then press Unmute.'
          : `Could not start the call: ${err.message}`,
      );
    });
    return () => {
      session.end();
    };
    // Start once per page visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const endCall = async () => {
    const room = session.room.name;
    await session.end();
    // The report for this call is written in the background; the list highlights it.
    router.push(room ? `/reports?room=${encodeURIComponent(room)}` : '/');
  };

  return (
    <SessionProvider session={session}>
      <RoomContext.Provider value={session.room}>
        <AgentStepsProvider>
          <div className="flex min-h-screen flex-col">
            <CallHeader />
            <main className="mx-auto box-border flex w-full max-w-[1440px] flex-auto flex-col gap-6 p-4 sm:p-6 lg:flex-row">
              <VoicePanel onEnd={endCall} micError={micError} />
              <Conversation />
            </main>
          </div>
        </AgentStepsProvider>
        <RoomAudioRenderer />
        <StartAudio
          label="Click to allow audio"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-accent px-5 py-3 font-medium text-ground"
        />
      </RoomContext.Provider>
    </SessionProvider>
  );
}
