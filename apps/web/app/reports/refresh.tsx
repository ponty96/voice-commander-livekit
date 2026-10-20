'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Reloads the page data every few seconds while a report is still being written. */
export function RefreshWhile({ active, seconds = 5 }: { active: boolean; seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(timer);
  }, [active, seconds, router]);
  return null;
}
