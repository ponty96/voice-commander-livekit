'use client';

import { type ReactNode, createContext, useContext, useEffect, useState } from 'react';
import { useSessionContext } from '@livekit/components-react';
import { STEPS_TOPIC, type StepEvent } from '@vic/shared';

export interface ToolStep {
  id: string;
  name: string;
  input: string;
  startedAt: number;
  endedAt?: number;
  output?: string;
  error?: boolean;
}

const StepsContext = createContext<ToolStep[]>([]);

/**
 * Collects the tool steps the agent publishes on STEPS_TOPIC. A room allows one handler
 * per topic, so this lives once near the top and children read it with useAgentSteps.
 */
export function AgentStepsProvider({ children }: { children: ReactNode }) {
  const { room } = useSessionContext();
  const [steps, setSteps] = useState<ToolStep[]>([]);

  useEffect(() => {
    room.registerTextStreamHandler(STEPS_TOPIC, async (reader) => {
      const event = JSON.parse(await reader.readAll()) as StepEvent;
      setSteps((prev) => {
        if (event.type === 'tool_start') {
          return [...prev, { id: event.id, name: event.name, input: event.input, startedAt: event.at }];
        }
        return prev.map((s) =>
          s.id === event.id ? { ...s, endedAt: event.at, output: event.output, error: event.error } : s,
        );
      });
    });
    return () => room.unregisterTextStreamHandler(STEPS_TOPIC);
  }, [room]);

  return <StepsContext.Provider value={steps}>{children}</StepsContext.Provider>;
}

/** Tool steps in the order they started. */
export const useAgentSteps = () => useContext(StepsContext);
