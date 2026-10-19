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

## Run in Docker, connected to Astronomy Shop

`docker-compose.yml` runs the agent and the web app. The agent also joins Astronomy Shop's `opentelemetry-demo` network, so its MCP servers reach `http://grafana:3000/grafana` and `http://opensearch:9200` by service name. There are no host ports to track, and Astronomy Shop is unchanged.

1. Start Astronomy Shop first, because its network has to exist.
2. Export the LiveKit variables (and the Axiom ones if you use it) in your shell. Compose passes them through, and there is no `.env` file.
3. Run `docker compose up -d --build`, then open http://localhost:3000. If something else already uses port 3000, use `WEB_PORT=3100 docker compose up -d`.
4. Stop `pnpm dev` while the containers run. Otherwise two agents are registered and LiveKit picks either one for a call.

The image installs `mcp-grafana` and `opensearch-mcp-server-py` with `uv tool install`, and it includes the system CA certificates that the LiveKit SDK needs. MCP servers connect in the background after the agent's greeting, so a call starts right away. In a busy Docker VM, OpenSearch's server can take 30 to 40 seconds before its tools appear (`[agent] tools: …`). Astronomy Shop's load generator uses most of Docker's CPU, which is also why the agent runs with `cpu_shares: 4096`.

Check connectivity from inside the agent container:

```bash
docker compose exec agent node -e "fetch('http://grafana:3000/grafana/api/health').then(r => r.text()).then(console.log)"
docker compose exec agent node -e "fetch('http://opensearch:9200/_cat/indices/otel-logs-*?v').then(r => r.text()).then(console.log)"
docker compose logs agent | grep -E '\[mcp\]|\[agent\] tools'
```

To run the agent on your Mac with `pnpm dev` against the same stack, install the two MCP servers with `uv tool install mcp-grafana opensearch-mcp-server-py`, then export the URLs from `.env.example`. Grafana goes through the shop's proxy at `http://localhost:8080/grafana`. OpenSearch's host port is random, so the export looks it up.

`apps/web/components/agents-ui` and `hooks/agents-ui` come from the LiveKit Agents UI shadcn registry (`components.json` has it as `@agents-ui`).


## System context

The agent always knows what application it's investigating. It reads a Markdown file at startup and puts it in its instructions, after Commander's persona and before the tool knowledge files. Every conversation starts with this context.

- `SYSTEM_CONTEXT_PATH` names the file, relative to `apps/agent`. Docker Compose defaults it to [`context/astronomy-shop.md`](apps/agent/context/astronomy-shop.md). For `pnpm dev`, export it (see `.env.example`). If it's unset, the agent has no system context.
- To investigate a different application, write a new file in `apps/agent/context/` and point `SYSTEM_CONTEXT_PATH` at it. No code changes. In Docker the folder is mounted read-only, so edits need `docker compose restart agent`, not a rebuild.
- The file is read once per process at startup. If the path is set but the file is missing or empty, the agent stops with an error instead of running without it.
- Startup logs `[agent] system context: context/astronomy-shop.md (510 chars)`. To check that the LLM uses it, ask "what does this application do?" on a call. It answers from the file without calling a tool.

Keep this file to what the application is and how its parts fit together. How to use a tool belongs in `skills/`, and runbooks and live data belong behind tools.

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

`list_deploys` is a template: a placeholder that only logs and returns "not connected". Copy it as a starting point, or replace its `execute` with a real call.

### Add an MCP server

Add it under `mcpServers` in [`apps/agent/mcp.json`](apps/agent/mcp.json), in the same format Claude Desktop and Cursor use. On each call the agent connects to every server after its greeting, lists its tools (`tools/list`), and adds them to the LLM as `<server>__<tool>`, for example `grafana__query_prometheus`. Until then the LLM has only the custom tools. Calls go through `tools/call` on the same connection, which closes when the call ends. A server that is missing a variable or fails to connect is skipped with a `[mcp] skipping ...` line, and the rest keep working.

**Local servers (stdio).** These run the installed `mcp-grafana` and `opensearch-mcp-server-py` commands (`uv tool install …`, already in the Docker image). `"command": "uvx"` with the package name in `args` works too, but it starts more slowly. Astronomy Shop's Grafana allows anonymous access, so it needs no token. For a Grafana that does, add `"GRAFANA_SERVICE_ACCOUNT_TOKEN": "${GRAFANA_SERVICE_ACCOUNT_TOKEN}"` to `env`.

```json
{
  "mcpServers": {
    "grafana": {
      "command": "mcp-grafana",
      "args": ["--disable-write"],
      "env": { "GRAFANA_URL": "${GRAFANA_URL}" }
    },
    "opensearch": {
      "command": "opensearch-mcp-server-py",
      "env": { "OPENSEARCH_URL": "${OPENSEARCH_URL}", "OPENSEARCH_NO_AUTH": "true" }
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

All three are in `mcp.json`, and each one stays skipped until its variables are set. OAuth-only servers aren't supported yet, and neither is the older SSE transport.

### Teach the LLM how to use a server's tools

MCP tools describe their parameters but not your data, so the LLM ends up guessing metric names, index names and datasource IDs. To prevent that, write what it needs to know in a Markdown file under [`apps/agent/skills/`](apps/agent/skills) and point the server at it with `knowledge_context_file`. The path is relative to `mcp.json`.

```json
"grafana": {
  "command": "mcp-grafana",
  "knowledge_context_file": "skills/grafana.md",
  ...
}
```

Once a server connects, the agent adds its file to the LLM's instructions under "How to use the grafana tools". A file that's missing is logged (`[mcp] grafana: could not read knowledge_context_file ...`), and the server still loads. Good things to put in the file are the IDs and names to use (datasource UIDs, index patterns, field names), two or three working queries, and the mistakes to avoid. [`skills/grafana.md`](apps/agent/skills/grafana.md) and [`skills/opensearch.md`](apps/agent/skills/opensearch.md) cover the Astronomy Shop stack. Keep them short, because the LLM reads them on every turn.

### Credentials

`${VAR}` anywhere in a server's `command`, `args`, `env`, `url` or `headers` is replaced with that environment variable. Nothing is read from files, so export the variables in the shell that runs the agent, the same way as the LiveKit ones (`.env.example` lists them):

```bash
export GRAFANA_URL=http://localhost:8080/grafana
export OPENSEARCH_URL=http://localhost:$(docker port opensearch 9200 | head -1 | cut -d: -f2)
export AXIOM_PAT=xapt-...
export AXIOM_ORG_ID=your-org
```

Resolved values are replaced with `***` in the terminal logs and in the events sent to the page.

### Check which tools are available

Start a call (`pnpm dev`, then Join). The agent terminal prints one line per MCP server and the full tool list:

```text
[mcp] grafana: 62 tools (alerting_manage_routing, ..., search_dashboards, ...)
[mcp] opensearch: 9 tools (ListIndexTool, IndexMappingTool, SearchIndexTool, ...)
[mcp] skipping axiom: set AXIOM_PAT, AXIOM_ORG_ID to enable it
[mcp] grafana: loaded knowledge from skills/grafana.md
[agent] tools: list_deploys, grafana__search_dashboards, ...
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
loadSystemContext()                     src/instructions.ts     at startup: reads SYSTEM_CONTEXT_PATH (relative to apps/agent); throws if set but missing or empty
cli.runApp(new ServerOptions(...))      src/agent.ts            registers the worker with LiveKit and waits for rooms
└─ defineAgent.entry(ctx)               src/agent.ts            runs once per room the agent is sent to
   ├─ [ctx.connect]                                             joins the room
   ├─ createPublisher(room)             src/tools/events.ts     sends StepEvents on vic.steps; never throws
   ├─ wrapCustomTools(tools, publish)   src/tools/index.ts      the custom tools as LLM tools, so the call starts without MCP
   │  └─ tools.config.ts (default)      tools.config.ts         custom tools, each made with defineTool()
   │     └─ defineTool(tool)            src/tools/define.ts     keeps Zod types for execute(); returns the tool as-is
   ├─ buildInstructions(base, ctx)      src/instructions.ts     persona, then system context, then tool knowledge (added later)
   ├─ new voice.Agent({instructions, tools})                    Commander's persona and system context, starting with the custom tools
   ├─ new voice.AgentSession({stt, llm, tts})                   Deepgram, GPT-4.1 mini, Cartesia via LiveKit Inference
   ├─ session.on(...)                                           logs user transcripts, state changes and replies to the terminal
   ├─ [session.start]                                           starts listening; publishes transcripts and lk.agent.state
   ├─ [session.say]                                             speaks the greeting
   ├─ loadTools({customTools, publish}) src/tools/index.ts      after the greeting: custom tools plus every MCP server's tools
   │  ├─ wrapCustomTools(...)           src/tools/index.ts      as above, now with credentials redacted
   │  ├─ connectMcpServers(path)        src/tools/mcp.ts        reads mcp.json and connects to every server in parallel
   │  │  ├─ readMcpConfig(path)         src/tools/mcp.ts        parses mcp.json; no file means no servers
   │  │  ├─ resolveEnv(config)          src/tools/mcp.ts        fills ${VAR}s from the environment; skips servers missing any
   │  │  ├─ connectMcpServer(name, cfg) src/tools/mcp.ts        connects over stdio or HTTP and pages through tools/list
   │  │  │  ├─ createTransport(cfg)     src/tools/mcp.ts        StdioClientTransport (keeps PATH) or StreamableHTTPClientTransport
   │  │  │  └─ withTimeout(p, ms)       src/tools/mcp.ts        gives up on a server after 60s
   │  │  └─ readKnowledge(name, file)   src/tools/mcp.ts        reads the server's knowledge_context_file; a missing file is only logged
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
   │  ├─ knowledgeInstructions(conns)   src/tools/index.ts      turns the knowledge files into "How to use the <server> tools" sections
   │  └─ close()                        src/tools/index.ts      closes every MCP connection; run by the shutdown callback
   ├─ [agent.updateTools(tools)]                                gives the LLM the full tool set once the servers are up
   └─ [agent.updateInstructions(...)]                           rebuilt with buildInstructions to add the knowledge sections
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
