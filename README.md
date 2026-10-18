# Voice Incident Commander

pnpm monorepo:

- `apps/web`: Next.js + React client. `/` has a Join button, `/call` is the call page (Agents UI bar visualizer plus a transcript and agent-steps panel). `GET /api/token` mints a token for a fresh `vc-room-*` room.
- `apps/agent`: LiveKit Agents voice agent (Deepgram STT, GPT-4.1 mini, Cartesia TTS, all through LiveKit Inference). Its tools come from `tools.config.ts` and `mcp.json` (see [Tools](#tools)), and each call is published to the call page on the `vic.steps` text stream.
- `packages/shared`: types and constants used by both.

## Setup

1. Export `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in the shell you run the apps from. Both apps read them from the environment only. `.env.example` is a template you can copy to `.env.local` and `source`.
2. `corepack enable` (or `npm i -g pnpm`), then `pnpm install`.
3. `pnpm dev` runs both apps, or `pnpm dev:web` / `pnpm dev:agent` separately.
4. Open http://localhost:3000, click Join, and talk.

`apps/web/components/agents-ui` and `hooks/agents-ui` come from the LiveKit Agents UI shadcn registry (`components.json` has it as `@agents-ui`).


## Tools

The agent gives the LLM two kinds of tools, and both go through the same wrapper, so every call shows up in the call page's activity log:

```text
apps/agent/tools.config.ts      apps/agent/mcp.json
          |                              |
   custom TypeScript tools      tools discovered on MCP servers
          +--------------+---------------+
                         v
            loadTools() -> runTool() -> LLM
```

Changes to either file apply from the next call; the agent code doesn't change.

### Add a custom TypeScript tool

Add a `defineTool(...)` entry to [`apps/agent/tools.config.ts`](apps/agent/tools.config.ts). `execute` gets arguments typed from the Zod schema, can be async, and whatever it returns goes to the LLM (strings as-is, anything else as JSON). Throw to report a failure.

```ts
defineTool({
  name: 'get_service_status',
  description: 'Get the current health status of a service from the status page.',
  parameters: z.object({
    service: z.string().describe('Service name, for example "checkout"'),
  }),
  execute: async ({ service }) => {
    const res = await fetch(`https://status.example.com/api/services/${service}`, {
      headers: { Authorization: `Bearer ${process.env.STATUS_API_TOKEN}` },
    });
    if (!res.ok) throw new Error(`status page returned ${res.status}`);
    return res.json();
  },
}),
```

The three built-in tools (`search_logs`, `query_metrics`, `list_deploys`) are placeholders that return "not connected" until you replace their `execute`.

### Add an MCP server

Add it under `mcpServers` in [`apps/agent/mcp.json`](apps/agent/mcp.json), in the same format Claude Desktop and Cursor use. On each call the agent connects to every server, lists its tools (`tools/list`), and gives them to the LLM as `<server>__<tool>`, for example `grafana__query_prometheus`. Calls go through `tools/call` on the same connection, which closes when the call ends. A server that is missing a variable or fails to connect is skipped with a `[mcp] skipping ...` line, and the rest keep working.

**Local server (stdio).** This runs `uvx mcp-grafana` (it needs [uv](https://docs.astral.sh/uv/)) with the two variables passed through:

```json
{
  "mcpServers": {
    "grafana": {
      "command": "uvx",
      "args": ["mcp-grafana"],
      "env": {
        "GRAFANA_URL": "${GRAFANA_URL}",
        "GRAFANA_SERVICE_ACCOUNT_TOKEN": "${GRAFANA_SERVICE_ACCOUNT_TOKEN}"
      }
    }
  }
}
```

**Remote server (Streamable HTTP)** with headers:

```json
{
  "mcpServers": {
    "axiom": {
      "url": "https://mcp.axiom.co/mcp",
      "headers": {
        "Authorization": "Bearer ${AXIOM_PAT}",
        "x-axiom-org-id": "${AXIOM_ORG_ID}"
      }
    }
  }
}
```

Both of these are already in `mcp.json`, and they stay skipped until their variables are set. OAuth-only servers aren't supported yet, and neither is the older SSE transport.

### Credentials

`${VAR}` anywhere in a server's `command`, `args`, `env`, `url` or `headers` is replaced with that environment variable. Nothing is read from files, so export the variables in the shell that runs the agent, the same way as the LiveKit ones (`.env.example` lists them):

```bash
export GRAFANA_URL=https://yourorg.grafana.net
export GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_...
export AXIOM_PAT=xapt-...
export AXIOM_ORG_ID=your-org
```

Resolved values are replaced with `***` in the terminal logs and in the events sent to the page.

### Check which tools are available

Start a call (`pnpm dev`, then Join). The agent terminal prints one line per MCP server and the full tool list:

```text
[mcp] grafana: <n> tools (search_dashboards, query_prometheus, ...)
[mcp] skipping axiom: set AXIOM_PAT, AXIOM_ORG_ID to enable it
[agent] tools: search_logs, query_metrics, list_deploys, grafana__search_dashboards, ...
```

`pnpm test` runs the agent tests. They start a local stdio MCP server and an HTTP MCP server and check discovery, calls, errors and the events.

### Tool execution events

Every tool call, custom or MCP, publishes two JSON messages to the room on the `vic.steps` text stream. The call page uses them to draw the steps in the conversation.

```text
tool_start  { id, name, input, at }          input is the arguments as "key=value ..." text
tool_end    { id, output, error, at }        same id; error is true if the tool threw or the MCP server returned isError
```

`at` is a millisecond timestamp. `output` is the tool's real result, cut to 2000 characters for the page (the LLM still gets all of it). A `tool_end` is always sent, also when the tool fails. If sending an event fails, the tool call still goes ahead. The agent terminal logs the same calls as `[tool] <name> <input>` lines.

## Call tree

How the code calls into itself today, from each entry point down. One line per function. Library calls are in brackets.

### Agent (`apps/agent`)

```
cli.runApp(new ServerOptions(...))      src/agent.ts            registers the worker with LiveKit and waits for rooms
└─ defineAgent.entry(ctx)               src/agent.ts            runs once per room the agent is sent to
   ├─ [ctx.connect]                                             joins the room
   ├─ createPublisher(room)             src/tools/events.ts     sends StepEvents on vic.steps; never throws
   ├─ loadTools({customTools, publish}) src/tools/index.ts      builds every tool the LLM gets
   │  ├─ tools.config.ts (default)      tools.config.ts         custom tools, each made with defineTool()
   │  │  └─ defineTool(tool)            src/tools/define.ts     keeps Zod types for execute(); returns the tool as-is
   │  ├─ connectMcpServers(path)        src/tools/mcp.ts        reads mcp.json and connects to every server in parallel
   │  │  ├─ readMcpConfig(path)         src/tools/mcp.ts        parses mcp.json; no file means no servers
   │  │  ├─ resolveEnv(config)          src/tools/mcp.ts        fills ${VAR}s from the environment; skips servers missing any
   │  │  └─ connectMcpServer(name, cfg) src/tools/mcp.ts        connects over stdio or HTTP and pages through tools/list
   │  │     ├─ createTransport(cfg)     src/tools/mcp.ts        StdioClientTransport (keeps PATH) or StreamableHTTPClientTransport
   │  │     └─ withTimeout(p, ms)       src/tools/mcp.ts        gives up on a server after 15s
   │  ├─ createRedactor(secrets)        src/tools/events.ts     replaces resolved credentials with ***
   │  ├─ mcpToolName(server, tool)      src/tools/mcp.ts        "<server>__<tool>", safe for the LLM
   │  ├─ [llm.tool] per tool                                    registers it; execute() calls runTool
   │  │  └─ runTool({name, args, run})  src/tools/events.ts     shared wrapper for custom and MCP tools
   │  │     ├─ formatInput(args)        src/tools/events.ts     arguments as "key=value" text
   │  │     ├─ publish(tool_start)
   │  │     ├─ run()                                            custom: tool.execute(args); MCP: [client.callTool] then callResultToText
   │  │     │  └─ callResultToText(res) src/tools/mcp.ts        joins the text content; throws if isError
   │  │     ├─ formatOutput(value)      src/tools/events.ts     strings as-is, anything else as JSON
   │  │     └─ publish(tool_end)                                same id, error: true if run() threw
   │  └─ close()                        src/tools/index.ts      closes every MCP connection
   ├─ [ctx.addShutdownCallback(close)]                          closes MCP connections when the call ends
   ├─ new voice.Agent({instructions, tools})                    Commander's persona and tools
   ├─ new voice.AgentSession({stt, llm, tts})                   Deepgram, GPT-4.1 mini, Cartesia via LiveKit Inference
   ├─ session.on(...)                                           logs user transcripts, state changes and replies to the terminal
   ├─ [session.start]                                           starts listening; publishes transcripts and lk.agent.state
   └─ [session.say]                                             speaks the greeting
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
STEPS_TOPIC     text stream topic for tool steps, used by createPublisher() and AgentStepsProvider
StepEvent       tool_start / tool_end message shape
TokenResponse   body of GET /api/token
```
