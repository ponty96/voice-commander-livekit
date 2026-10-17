import { NextResponse, type NextRequest } from 'next/server';
import { AccessToken } from 'livekit-server-sdk';
import type { TokenResponse } from '@vic/shared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return NextResponse.json(
      { error: 'LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set in the environment' },
      { status: 500 },
    );
  }

  // Each call gets its own room, so the agent starts fresh every time.
  const roomName = req.nextUrl.searchParams.get('room') ?? `vc-room-${Math.random().toString(16).slice(2, 6)}`;
  const identity =
    req.nextUrl.searchParams.get('identity') ?? `commander-${Math.random().toString(36).slice(2, 8)}`;

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, ttl: '1h' });
  at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true });

  const body: TokenResponse = {
    serverUrl: LIVEKIT_URL,
    participantToken: await at.toJwt(),
    roomName,
    identity,
  };
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
