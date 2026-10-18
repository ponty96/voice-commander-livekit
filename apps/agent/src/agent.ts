import { fileURLToPath } from 'node:url';
import { type JobContext, ServerOptions, cli, defineAgent, inference, voice } from '@livekit/agents';
import customTools from '../tools.config.js';
import { createPublisher } from './tools/events.js';
import { loadTools, wrapCustomTools } from './tools/index.js';

const INSTRUCTIONS = `You are Commander, a voice assistant that helps an on-call engineer investigate production incidents.
You talk out loud, so keep replies short and conversational, with no markdown, lists or symbols.
Use your tools to investigate when the engineer asks about a problem.
Some tools are placeholders that only log the request and return no data. Prefer the connected tools (their names start with a server name, like grafana__ or opensearch__) when one fits.
When that happens, say plainly which checks you ran and that no data came back. Never make up logs, metrics or deploys.`;

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    console.log(`[agent] joined room ${ctx.room.name}`);

    const publish = createPublisher(ctx.room);
    // Start with the custom tools so the call doesn't wait on MCP servers; theirs are added below.
    const agent = new voice.Agent({ instructions: INSTRUCTIONS, tools: wrapCustomTools(customTools, publish) });
    let closeMcp = async () => {};
    ctx.addShutdownCallback(() => closeMcp());

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

    await session.start({ agent, room: ctx.room });
    session.say("Commander here. What's going on?");

    const { tools, close } = await loadTools({ customTools, publish });
    closeMcp = close;
    await agent.updateTools(tools);
    console.log(`[agent] tools: ${tools.map((t) => t.name).join(', ')}`);
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    // The default 10s is too short when Docker's CPUs are busy (Astronomy Shop's load generator).
    initializeProcessTimeout: 30_000,
  }),
);
