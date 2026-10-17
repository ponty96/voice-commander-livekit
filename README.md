# Voice Incident Commander

pnpm monorepo:

- `apps/web`: Next.js + React client. `/` has a Join button, `/call` is the call page (Agents UI bar visualizer plus a transcript and agent-steps panel). `GET /api/token` mints a token for a fresh `vc-room-*` room.
- `apps/agent`: LiveKit Agents voice agent (Deepgram STT, GPT-4.1 mini, Cartesia TTS, all through LiveKit Inference). Its incident tools only log to the terminal and publish their steps to the call page on the `vic.steps` text stream.
- `packages/shared`: types and constants used by both.

## Setup

1. Export `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in the shell you run the apps from. Both apps read them from the environment only. `.env.example` is a template you can copy to `.env.local` and `source`.
2. `corepack enable` (or `npm i -g pnpm`), then `pnpm install`.
3. `pnpm dev` runs both apps, or `pnpm dev:web` / `pnpm dev:agent` separately.
4. Open http://localhost:3000, click Join, and talk.

`apps/web/components/agents-ui` and `hooks/agents-ui` come from the LiveKit Agents UI shadcn registry (`components.json` has it as `@agents-ui`).

Actions only log to the terminal for now.

## Call tree

How the code calls into itself today, from each entry point down. One line per function. Library calls are in brackets.

### Agent (`apps/agent/src`)

```
cli.runApp(new ServerOptions(...))      agent.ts       registers the worker with LiveKit and waits for rooms
└─ defineAgent.entry(ctx)               agent.ts       runs once per room the agent is sent to
   ├─ [ctx.connect]                                    joins the room
   ├─ createActions(room)               actions.ts     builds the incident tools the LLM can call
   │  ├─ publish(event)                 actions.ts     sends a StepEvent to the page on the vic.steps text stream
   │  └─ action(name, desc, schema)     actions.ts     wraps a tool so it logs, publishes start/end, returns NOT_CONNECTED
   │     └─ execute(args)               actions.ts     runs when the LLM calls the tool
   │        ├─ formatInput(args)        actions.ts     turns the arguments into "key=value" text
   │        ├─ publish(tool_start)
   │        ├─ console.log [action]                    the action itself: only logs to the terminal for now
   │        └─ publish(tool_end)
   │     tools: search_logs, query_metrics, list_deploys
   ├─ new voice.Agent({instructions, tools})           Commander's persona and tools
   ├─ new voice.AgentSession({stt, llm, tts})          Deepgram, GPT-4.1 mini, Cartesia via LiveKit Inference
   ├─ session.on(...)                                  logs user transcripts, state changes and replies to the terminal
   ├─ [session.start]                                  starts listening; publishes transcripts and lk.agent.state
   └─ [session.say]                                    speaks the greeting
```

### Web (`apps/web/app`)

```
GET /api/token                          api/token/route.ts       checks the env vars, mints a token for a new vc-room-* room

RootLayout                              layout.tsx               loads the fonts and global styles
├─ Home  (/)                            page.tsx                 landing page; Join links to /call
└─ CallPage  (/call)                    call/page.tsx            creates the session and starts it with the mic on
   ├─ [TokenSource.literal → fetch /api/token]                   gets serverUrl and token for the session
   ├─ [useSession → session.start]                               connects to the room; records a mic error if access is blocked
   ├─ endCall()                         call/page.tsx            ends the session and goes back to /
   ├─ AgentStepsProvider                call/use-agent-steps.tsx listens on vic.steps and keeps the list of tool steps
   │  ├─ CallHeader                     call/call-header.tsx     room name, call timer and connection pill
   │  │  └─ useElapsed(running)         call/call-header.tsx     mm:ss since the call connected
   │  ├─ VoicePanel                     call/voice-panel.tsx     status pill, visualizer, caption and call buttons
   │  │  ├─ [useAgent]                                           agent state and audio track
   │  │  ├─ useAgentSteps()             call/use-agent-steps.tsx reads the tool steps (for the "Running ..." caption)
   │  │  ├─ AgentAudioVisualizerBar     components/agents-ui     Agents UI bar visualizer driven by agent state and volume
   │  │  │  ├─ useAgentAudioVisualizerBarAnimator  hooks/agents-ui  picks which bars light up for each state
   │  │  │  ├─ normalizeVolumeBands     components/agents-ui     fits the volume bands to the bar count
   │  │  │  └─ cloneSingleChild         components/agents-ui     applies height and highlight to our custom bar element
   │  │  └─ MuteButton                  call/voice-panel.tsx     toggles the mic and shows a 3-bar mic level
   │  └─ Conversation                   call/conversation.tsx    the chat panel; auto-scrolls to the newest item
   │     ├─ [useSessionMessages]                                 user and agent transcripts
   │     ├─ useAgentSteps()             call/use-agent-steps.tsx tool steps
   │     ├─ buildTimeline(msgs, steps)  call/conversation.tsx    merges both by time and groups consecutive steps
   │     ├─ MessageBubble               call/conversation.tsx    your words (dashed while interim) or Commander's reply
   │     ├─ StepsBlock                  call/conversation.tsx    "Working · step N", folds to "Investigated in N steps"
   │     │  └─ StepRow                  call/conversation.tsx    one tool: name, input, output, duration or spinner
   │     └─ ThinkingRow                 call/conversation.tsx    spinner while the agent thinks with no tool running
   ├─ [RoomAudioRenderer]                                        plays the agent's voice
   └─ [StartAudio]                                               button shown if the browser blocks autoplay
```

### Shared (`packages/shared/src/index.ts`)

```
STEPS_TOPIC     text stream topic for tool steps, used by publish() and AgentStepsProvider
StepEvent       tool_start / tool_end message shape
TokenResponse   body of GET /api/token
```
