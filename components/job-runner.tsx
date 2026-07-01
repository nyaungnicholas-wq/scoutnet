"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { tickJobsAction } from "@/lib/actions";

/* While a background sweep is enriching, quietly drive it from the browser: every
   couple of seconds, ask the server to process a few more batches and refresh the
   page so progress (and new leads) appear live. Stops itself when the queue
   drains. The Vercel cron is the same worker for when nobody's watching. */
export function JobRunner({ hasActive }: { hasActive: boolean }) {
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    if (!hasActive) return;
    let stopped = false;
    async function tick() {
      if (busy.current || stopped) return;
      busy.current = true;
      setWorking(true);
      try {
        const r = await tickJobsAction();
        router.refresh();
        if (r.active === 0) stopped = true;
      } catch {
        /* transient — the next tick retries */
      } finally {
        busy.current = false;
        setWorking(false);
      }
    }
    void tick();
    const id = setInterval(() => void tick(), 2500);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [hasActive, router]);

  if (!hasActive) return null;
  return (
    <p className="mt-2 flex items-center gap-2 text-xs font-medium text-sky-700">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-sky-500" aria-hidden />
      {working ? "Enriching a batch…" : "Working in the background…"} new leads appear as they&rsquo;re scored.
    </p>
  );
}
