/** Text stream topic the agent uses to publish its tool steps to the call page. */
export const STEPS_TOPIC = 'vic.steps';

/** Response body of GET /api/token. */
export interface TokenResponse {
  serverUrl: string;
  participantToken: string;
  roomName: string;
  identity: string;
}

/** One message on STEPS_TOPIC, sent as JSON. */
export type StepEvent =
  | {
      type: 'tool_start';
      id: string;
      name: string;
      /** Tool arguments as a short `key=value` string. */
      input: string;
      at: number;
    }
  | {
      type: 'tool_end';
      id: string;
      output: string;
      error: boolean;
      at: number;
    };
