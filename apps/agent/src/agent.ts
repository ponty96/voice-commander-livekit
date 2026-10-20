import { fileURLToPath } from 'node:url';
import { type JobContext, ServerOptions, cli, defineAgent, inference, voice } from '@livekit/agents';
import customTools from '../tools.config.js';
import { buildInstructions, loadSystemContext } from './instructions.js';
import { generateReport } from './reporting/generate.js';
import { InvestigationRecorder } from './reporting/recorder.js';
import { createPublisher } from './tools/events.js';
import { customToolKnowledge, loadTools, wrapCustomTool } from './tools/index.js';

const VOICE_LLM = 'openai/gpt-4.1-mini';
/** Longest the report may take after a call before the job is stopped (the CLI can redo it). */
const REPORT_TIMEOUT_MS = 100_000;

const INSTRUCTIONS = `You are Commander, a voice assistant that helps an on-call engineer investigate production incidents.
You talk out loud, so keep replies short and conversational, with no markdown, lists or symbols.
Use your tools to investigate when the engineer asks about a problem, and answer every part of their question.
Some tools are placeholders that only log the request and return no data.
When that happens, say plainly which checks you ran and that no data came back. Never make up logs, metrics or deploys.`;

// Read once when the process starts (before the worker registers), so a bad path stops startup.
const SYSTEM_CONTEXT = loadSystemContext();
const CUSTOM_TOOL_KNOWLEDGE = customToolKnowledge(customTools);
const duplicate = customTools.find((t, i) => customTools.findIndex((u) => u.name === t.name) !== i);
if (duplicate) throw new Error(`Duplicate tool name "${duplicate.name}" in tools.config.ts`);

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    console.log(`[agent] joined room ${ctx.room.name}`);

    const publish = createPublisher(ctx.room);
    // One session is one investigation. The recorder only appends to disk and never throws.
    const recorder = InvestigationRecorder.start(ctx.room.name ?? 'unknown');
    const instructions = buildInstructions(INSTRUCTIONS, SYSTEM_CONTEXT, CUSTOM_TOOL_KNOWLEDGE);
    recorder.config(
      VOICE_LLM,
      instructions,
      customTools.map((t) => t.name),
    );
    // Start with the custom tools so the call doesn't wait on MCP servers; theirs are added below.
    const agent = new voice.Agent({
      instructions,
      tools: customTools.map((tool) => wrapCustomTool(tool, publish, undefined, recorder)),
    });
    // When the call ends: close MCP connections (also if they finish loading after that), write
    // record.json, then generate the report. The caller has left, so none of this affects audio.
    let ended = false;
    let closeReason = 'job_shutdown';
    let closeMcp = async () => {};
    ctx.addShutdownCallback(async () => {
      ended = true;
      await closeMcp();
      const facts = await recorder.end(closeReason);
      if (facts && facts.status !== 'abandoned') {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            console.error(`[report] gave up after ${REPORT_TIMEOUT_MS / 1000}s; run the report CLI to retry`);
            resolve();
          }, REPORT_TIMEOUT_MS);
        });
        await Promise.race([generateReport(recorder.dir).then(() => {}), timeout]);
        clearTimeout(timer);
      }
    });

    const session = new voice.AgentSession({
      stt: new inference.STT({ model: 'deepgram/nova-3', language: 'en' }),
      llm: new inference.LLM({ model: VOICE_LLM }),
      tts: new inference.TTS({ model: 'cartesia/sonic-3', voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc' }),
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal) console.log(`[user] ${ev.transcript}`);
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      console.log(`[agent] ${ev.oldState} -> ${ev.newState}`);
    });
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      if (ev.item.type !== 'message' || (ev.item.role !== 'assistant' && ev.item.role !== 'user')) return;
      const text = ev.item.textContent ?? '';
      if (ev.item.role === 'assistant') console.log(`[commander] ${text}`);
      recorder.message(ev.item.role, text, ev.item.interrupted);
    });

    // When the session closes (for example the caller hangs up), end the job so its shutdown
    // callbacks run and the MCP servers stop. Otherwise they live until LiveKit ends the room.
    session.on(voice.AgentSessionEventTypes.Close, (ev) => {
      closeReason = ev.error ? `error: ${ev.error.type}` : String(ev.reason);
      ctx.shutdown(`session closed: ${ev.reason}`);
    });

    await session.start({ agent, room: ctx.room });
    session.say("Commander here. What's going on?");

    let loaded: Awaited<ReturnType<typeof loadTools>>;
    try {
      loaded = await loadTools({ customTools, publish, record: recorder });
    } catch (err) {
      // loadTools has already closed its connections. The call carries on with the custom tools.
      console.error(`[agent] MCP tools not loaded: ${(err as Error).message}`);
      return;
    }
    if (ended) return loaded.close();
    closeMcp = loaded.close;
    await agent.updateTools(loaded.tools);
    const knowledge = [CUSTOM_TOOL_KNOWLEDGE, loaded.instructions].filter(Boolean).join('\n\n');
    const fullInstructions = buildInstructions(INSTRUCTIONS, SYSTEM_CONTEXT, knowledge);
    if (loaded.instructions) await agent.updateInstructions(fullInstructions);
    recorder.config(
      VOICE_LLM,
      fullInstructions,
      loaded.tools.map((t) => t.name),
    );
    console.log(`[agent] tools: ${loaded.tools.map((t) => t.name).join(', ')}`);
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    // The default 10s is too short when Docker's CPUs are busy (Astronomy Shop's load generator).
    initializeProcessTimeout: 30_000,
    // Leaves room to write the investigation report after a call ends.
    shutdownProcessTimeout: 120_000,
  }),
);
