import { fileURLToPath } from 'node:url';
import { type JobContext, ServerOptions, cli, defineAgent, inference, voice } from '@livekit/agents';
import customTools from '../tools.config.js';
import { createPublisher } from './tools/events.js';
import { loadTools } from './tools/index.js';

const INSTRUCTIONS = `You are Commander, a voice assistant that helps an on-call engineer investigate production incidents.
You talk out loud, so keep replies short and conversational, with no markdown, lists or symbols.
Use your tools to investigate when the engineer asks about a problem.
Some tools are placeholders that only log the request and return no data.
When that happens, say plainly which checks you ran and that no data came back. Never make up logs, metrics or deploys.`;

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    console.log(`[agent] joined room ${ctx.room.name}`);

    const { tools, close } = await loadTools({ customTools, publish: createPublisher(ctx.room) });
    ctx.addShutdownCallback(close);
    console.log(`[agent] tools: ${tools.map((t) => t.name).join(', ')}`);

    const agent = new voice.Agent({ instructions: INSTRUCTIONS, tools });

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
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
