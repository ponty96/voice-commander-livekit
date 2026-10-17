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
