'use client';

import { useEffect, useRef, useState } from 'react';
import { type ReceivedMessage, useAgent, useSessionContext, useSessionMessages } from '@livekit/components-react';
import { Check, ChevronDown, ChevronRight, LoaderCircle, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type ToolStep, useAgentSteps } from './use-agent-steps';

type Item =
  | { kind: 'message'; at: number; message: ReceivedMessage }
  | { kind: 'steps'; at: number; steps: ToolStep[]; done: boolean };

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Interleaves transcripts and tool steps by time, grouping consecutive steps into one block. */
function buildTimeline(messages: ReceivedMessage[], steps: ToolStep[]): Item[] {
  const flat = [
    ...messages.map((m) => ({ at: m.timestamp, message: m })),
    ...steps.map((s) => ({ at: s.startedAt, step: s })),
  ].sort((a, b) => a.at - b.at);

  const items: Item[] = [];
  for (const entry of flat) {
    if ('step' in entry) {
      const last = items[items.length - 1];
      if (last?.kind === 'steps') last.steps.push(entry.step);
      else items.push({ kind: 'steps', at: entry.at, steps: [entry.step], done: false });
    } else {
      items.push({ kind: 'message', at: entry.at, message: entry.message });
    }
  }
  // A block is done once the agent has replied after it.
  items.forEach((item, i) => {
    if (item.kind === 'steps') {
      item.done = items.slice(i + 1).some((n) => n.kind === 'message' && n.message.type === 'agentTranscript');
    }
  });
  return items;
}

export function Conversation() {
  const session = useSessionContext();
  const { messages } = useSessionMessages(session);
  const steps = useAgentSteps();
  const agent = useAgent();
  const items = buildTimeline(messages, steps);
  const last = items[items.length - 1];
  const thinking = agent.state === 'thinking';

  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [items.length, last?.kind === 'message' ? last.message.message : steps.length, thinking]);

  return (
    <section
      aria-label="Conversation"
      className="box-border flex min-h-[480px] min-w-0 flex-col rounded-2xl border border-line bg-panel lg:max-h-[calc(100vh-130px)] lg:min-h-[720px] lg:flex-[3_1_520px]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h2 className="m-0 text-base font-semibold">Conversation</h2>
        <span className="text-[13px] text-muted">Transcript and agent steps</span>
      </div>

      <div ref={scroller} className="flex flex-auto flex-col gap-5 overflow-y-auto p-5">
        {items.length === 0 && !thinking && (
          <p className="m-auto text-center text-[15px] text-muted">
            What you say and what Commander does will show up here.
          </p>
        )}
        {items.map((item) =>
          item.kind === 'message' ? (
            <MessageBubble key={item.message.id} message={item.message} />
          ) : (
            <StepsBlock
              key={item.steps[0].id}
              steps={item.steps}
              done={item.done}
              thinking={thinking && last === item}
            />
          ),
        )}
        {thinking && last?.kind !== 'steps' && <ThinkingRow />}
      </div>
    </section>
  );
}

function MessageBubble({ message }: { message: ReceivedMessage }) {
  if (message.type === 'agentTranscript') {
    return (
      <div className="flex flex-col items-start gap-1.5">
        <span className="text-xs font-semibold text-accent">Commander · {time(message.timestamp)}</span>
        <p className="m-0 max-w-[85%] text-[15px] leading-relaxed">{message.message}</p>
      </div>
    );
  }
  if (message.type !== 'userTranscript') return null;

  const interim = message.attributes?.['lk.transcription_final'] === 'false';
  return (
    <div className="flex flex-col items-end gap-1.5">
      {interim ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          <span className="size-1.5 animate-pulse-soft rounded-full bg-accent" />
          You · speaking
        </span>
      ) : (
        <span className="text-xs text-muted">You · {time(message.timestamp)}</span>
      )}
      <p
        className={cn(
          'm-0 max-w-[80%] rounded-[16px_16px_4px_16px] border px-4 py-3 text-[15px] leading-normal',
          interim
            ? 'border-dashed border-you-line bg-transparent text-you-interim'
            : 'border-you-line bg-you text-you-ink',
        )}
      >
        {message.message}
        {interim && <span className="animate-caret text-accent">|</span>}
      </p>
    </div>
  );
}

function StepsBlock({ steps, done, thinking }: { steps: ToolStep[]; done: boolean; thinking: boolean }) {
  const [open, setOpen] = useState(false);
  const expanded = !done || open;
  const finished = steps.filter((s) => s.endedAt !== undefined);
  const duration = finished.length
    ? Math.max(...finished.map((s) => s.endedAt!)) - Math.min(...steps.map((s) => s.startedAt))
    : 0;
  const label = done
    ? `Investigated in ${steps.length} step${steps.length === 1 ? '' : 's'} · ${seconds(duration)}`
    : `Working · step ${steps.length}`;

  return (
    <div className="flex max-w-[90%] flex-col gap-2">
      <button
        type="button"
        onClick={() => done && setOpen((o) => !o)}
        aria-expanded={expanded}
        disabled={!done}
        className={cn(
          'inline-flex w-fit items-center gap-2 bg-transparent p-0 text-[13px]',
          done ? 'cursor-pointer text-muted hover:text-ink' : 'text-ink',
        )}
      >
        {expanded ? <ChevronDown aria-hidden="true" size={14} /> : <ChevronRight aria-hidden="true" size={14} />}
        {label}
      </button>
      {expanded && (
        <ol className="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-line bg-ground p-0">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
          {thinking && steps.every((s) => s.endedAt !== undefined) && (
            <li className="border-t border-line">
              <ThinkingRow bare />
            </li>
          )}
        </ol>
      )}
    </div>
  );
}

function StepRow({ step }: { step: ToolStep }) {
  const running = step.endedAt === undefined;
  return (
    <li className={cn('flex items-start gap-3 border-line px-3.5 py-3 not-first:border-t', running && 'bg-running')}>
      {running ? (
        <LoaderCircle aria-label="Running" size={16} className="mt-0.5 flex-none animate-spin text-accent" />
      ) : step.error ? (
        <TriangleAlert aria-label="Failed" size={16} className="mt-0.5 flex-none text-danger-ink" />
      ) : (
        <Check aria-label="Done" size={16} strokeWidth={2.4} className="mt-0.5 flex-none text-ok" />
      )}
      <div className="flex min-w-0 flex-auto flex-col gap-1">
        <div className="flex flex-wrap justify-between gap-2">
          <span className="font-mono text-[13px]">{step.name}</span>
          <span className={cn('font-mono text-xs', running ? 'text-accent' : 'text-muted')}>
            {running ? 'running' : seconds(step.endedAt! - step.startedAt)}
          </span>
        </div>
        {step.input && <span className="font-mono text-xs break-all text-muted">{step.input}</span>}
        {step.output && <span className="text-sm text-ink-soft">{step.output}</span>}
      </div>
    </li>
  );
}

function ThinkingRow({ bare }: { bare?: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 px-3.5 py-3 text-sm text-muted italic',
        !bare && 'w-fit rounded-xl border border-line bg-ground',
      )}
    >
      <LoaderCircle aria-hidden="true" size={16} className="flex-none animate-spin text-accent" />
      Thinking
    </div>
  );
}
