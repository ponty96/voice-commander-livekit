'use client';

import { type LocalAudioTrack, Track } from 'livekit-client';
import {
  type AgentState,
  useAgent,
  useLocalParticipant,
  useMultibandTrackVolume,
  useTrackToggle,
} from '@livekit/components-react';
import { Mic, MicOff, X } from 'lucide-react';
import { AgentAudioVisualizerBar } from '@/components/agents-ui/agent-audio-visualizer-bar';
import { cn } from '@/lib/utils';
import { useAgentSteps } from './use-agent-steps';

const STATE_LABEL: Partial<Record<AgentState, string>> = {
  connecting: 'Connecting',
  initializing: 'Connecting',
  'pre-connect-buffering': 'Connecting',
  idle: 'Idle',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  failed: 'Unavailable',
  disconnected: 'Disconnected',
};

export function VoicePanel({ onEnd, micError }: { onEnd: () => void; micError: string | null }) {
  const agent = useAgent();
  const steps = useAgentSteps();
  const { isMicrophoneEnabled } = useLocalParticipant();
  const running = steps.findLast((s) => s.endedAt === undefined);

  let caption = 'Waiting for Commander to join.';
  if (agent.state === 'failed') caption = agent.failureReasons.join(' ');
  else if (micError && !isMicrophoneEnabled) caption = micError;
  else if (agent.state === 'listening')
    caption = 'Commander is listening. Keep talking, it will answer when you pause.';
  else if (agent.state === 'thinking') caption = running ? `Running ${running.name}` : 'Thinking';
  else if (agent.state === 'speaking') caption = 'Commander is speaking.';

  return (
    <section
      aria-label="Agent voice"
      className="box-border flex min-h-[420px] min-w-0 flex-col items-center justify-between gap-8 rounded-2xl border border-line bg-panel px-6 py-8 lg:min-h-[720px] lg:flex-[2_1_380px]"
    >
      <span className="inline-flex items-center gap-2 rounded-full border border-line bg-ground px-3.5 py-1.5 text-[13px]">
        <span className={cn('size-2 rounded-full bg-accent', agent.state !== 'speaking' && 'animate-pulse-soft')} />
        {STATE_LABEL[agent.state] ?? agent.state}
      </span>

      <div className="flex flex-col items-center gap-7">
        <AgentAudioVisualizerBar
          size="lg"
          barCount={5}
          state={agent.state}
          audioTrack={agent.microphoneTrack}
          color="#f0883e"
          className="h-[240px] max-sm:h-[160px]"
          aria-label={`Agent audio visualizer, ${STATE_LABEL[agent.state] ?? agent.state}`}
          role="img"
        >
          <div className="min-h-[52px] w-[52px] rounded-full bg-line data-[lk-highlighted=true]:bg-accent max-sm:min-h-9 max-sm:w-9" />
        </AgentAudioVisualizerBar>
        <p aria-live="polite" className="m-0 max-w-[320px] text-center text-[15px] text-muted">
          {caption}
        </p>
      </div>

      <div className="flex flex-wrap justify-center gap-3">
        <MuteButton />
        <button
          type="button"
          onClick={onEnd}
          className="inline-flex min-h-12 cursor-pointer items-center gap-2.5 rounded-full border border-danger bg-transparent px-5 text-[15px] text-danger-ink hover:bg-danger/10"
        >
          <X aria-hidden="true" size={18} />
          End session
        </button>
      </div>
    </section>
  );
}

function MuteButton() {
  const { enabled, toggle, pending } = useTrackToggle({ source: Track.Source.Microphone });
  const { microphoneTrack } = useLocalParticipant();
  const bands = useMultibandTrackVolume(microphoneTrack?.track as LocalAudioTrack | undefined, { bands: 3 });

  return (
    <button
      type="button"
      onClick={() => toggle()}
      disabled={pending}
      aria-label={enabled ? 'Mute microphone' : 'Unmute microphone'}
      aria-pressed={!enabled}
      className="inline-flex min-h-12 cursor-pointer items-center gap-2.5 rounded-full border border-line bg-ground px-5 text-[15px] hover:border-muted disabled:opacity-60"
    >
      {enabled ? <Mic aria-hidden="true" size={18} /> : <MicOff aria-hidden="true" size={18} />}
      <span aria-hidden="true" className="inline-flex h-4 items-end gap-[3px]">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn('w-[3px] rounded-sm', enabled ? 'bg-ok' : 'bg-line')}
            style={{ height: enabled ? `${Math.max(4, Math.round((bands[i] ?? 0) * 16))}px` : '4px' }}
          />
        ))}
      </span>
      {enabled ? 'Mute' : 'Unmute'}
    </button>
  );
}
