import { fileURLToPath } from 'node:url';
import { type JobContext, ServerOptions, cli, defineAgent, inference, voice } from '@livekit/agents';
import customTools from '../tools.config.js';
import { buildInstructions, loadSystemContext } from './instructions.js';
import { createPublisher } from './tools/events.js';
import { customToolKnowledge, loadTools, wrapCustomTool } from './tools/index.js';

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
    // Start with the custom tools so the call doesn't wait on MCP servers; theirs are added below.
    const agent = new voice.Agent({
      instructions: buildInstructions(INSTRUCTIONS, SYSTEM_CONTEXT, CUSTOM_TOOL_KNOWLEDGE),
      tools: customTools.map((tool) => wrapCustomTool(tool, publish)),
    });
    // Close MCP connections when the call ends, including when it ends before they finish loading.
    let ended = false;
    let closeMcp = async () => {};
    ctx.addShutdownCallback(async () => {
      ended = true;
      await closeMcp();
    });

    const session = new voice.AgentSession({
      stt: new inference.STT({ model: 'deepgram/nova-3', language: 'en' }),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      tts: new inference.TTS({ model: 'cartesia/sonic-3', voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc' }),
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal) console.log(`[user] ${ev.transcript}`);
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      console.log(`[agent] ${ev.oldState} -> ${ev.newState}`);
    });
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      if (ev.item.type === 'message' && ev.item.role === 'assistant') {
        console.log(`[commander] ${ev.item.textContent ?? ''}`);
      }
    });

    // When the session closes (for example the caller hangs up), end the job so its shutdown
    // callbacks run and the MCP servers stop. Otherwise they live until LiveKit ends the room.
    session.on(voice.AgentSessionEventTypes.Close, (ev) => ctx.shutdown(`session closed: ${ev.reason}`));

    await session.start({ agent, room: ctx.room });
    session.say("Commander here. What's going on?");

    let loaded: Awaited<ReturnType<typeof loadTools>>;
    try {
      loaded = await loadTools({ customTools, publish });
    } catch (err) {
      // loadTools has already closed its connections. The call carries on with the custom tools.
      console.error(`[agent] MCP tools not loaded: ${(err as Error).message}`);
      return;
    }
    if (ended) return loaded.close();
    closeMcp = loaded.close;
    await agent.updateTools(loaded.tools);
    if (loaded.instructions) {
      const knowledge = [CUSTOM_TOOL_KNOWLEDGE, loaded.instructions].filter(Boolean).join('\n\n');
      await agent.updateInstructions(buildInstructions(INSTRUCTIONS, SYSTEM_CONTEXT, knowledge));
    }
    console.log(`[agent] tools: ${loaded.tools.map((t) => t.name).join(', ')}`);
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    // The default 10s is too short when Docker's CPUs are busy (Astronomy Shop's load generator).
    initializeProcessTimeout: 30_000,
  }),
);
