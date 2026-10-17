import Link from 'next/link';

export default function Home() {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="flex flex-col items-center gap-6 text-center">
        <span className="text-xs font-semibold tracking-[0.08em] text-accent uppercase">Voice Incident Commander</span>
        <h1 className="m-0 text-3xl font-semibold">Talk through an incident</h1>
        <p className="m-0 max-w-sm text-muted">Join a call with Commander. It listens, investigates and answers out loud.</p>
        <Link
          href="/call"
          className="inline-flex min-h-12 items-center rounded-full bg-accent px-6 font-medium text-ground hover:bg-[#ffa657]"
        >
          Join
        </Link>
      </div>
    </main>
  );
}
