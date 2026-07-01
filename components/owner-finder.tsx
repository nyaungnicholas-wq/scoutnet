"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { tickOwnersAction } from "@/lib/actions";

type Found = { business: string; firstName: string; source: string; evidence?: string };

/* Background owner-finder, driven from the browser. While leads still lack an owner
   name, every few seconds it asks the server to attempt a few more (parse the
   business name, then — when the AI engine is on — read the owner off the site's
   About/Team page with the exact sentence as proof), shows each hit in a live feed,
   and refreshes so the new "Hi {name}," greetings appear. Pauses when toggled off;
   stops itself once every lead has been tried. */
export function OwnerFinder({
  pending,
  found,
  total,
  aiKeySource,
}: {
  pending: number;
  found: number;
  total: number;
  aiKeySource: "explicit" | "places" | "none";
}) {
  const aiLive = aiKeySource === "explicit";
  const router = useRouter();
  // Auto-start whenever there are leads to check (e.g. right after a discovery
  // run), so owner-finding kicks off on its own. The user can still Pause.
  const [on, setOn] = useState(pending > 0);
  const [remaining, setRemaining] = useState(pending);
  const [feed, setFeed] = useState<Found[]>([]);
  const [working, setWorking] = useState(false);
  const busy = useRef(false);

  useEffect(() => setRemaining(pending), [pending]);

  useEffect(() => {
    if (!on || remaining <= 0) return;
    let stopped = false;
    async function tick() {
      if (busy.current || stopped) return;
      busy.current = true;
      setWorking(true);
      try {
        const r = await tickOwnersAction();
        setRemaining(r.remaining);
        if (r.found.length) {
          setFeed((prev) => [...r.found, ...prev].slice(0, 12));
          router.refresh();
        }
        if (r.remaining <= 0) stopped = true;
      } catch {
        /* transient — next tick retries */
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
  }, [on, remaining, router]);

  const coverage = total > 0 ? Math.round((found / total) * 100) : 0;

  return (
    <div className="card-soft p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-800">
            🔎 Auto owner-finder{" "}
            <span className="font-normal text-slate-500">
              — {aiLive ? "AI reads each site’s About page" : "free engine: business name + website"}
            </span>
            {aiLive ? (
              <span className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-800">
                AI on
              </span>
            ) : aiKeySource === "places" ? (
              <span className="ml-2 rounded bg-accent-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-600">
                AI needs 1 click
              </span>
            ) : (
              <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                AI off
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            <span className="font-semibold text-slate-700">
              {found} of {total} ({coverage}%)
            </span>{" "}
            have a first name
            {remaining > 0 ? ` · ${remaining} still to check` : " · all checked"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOn((v) => !v)}
          disabled={remaining <= 0}
          className={`rounded-lg px-3 py-2 text-sm font-medium ${
            on
              ? "bg-amber-100 text-amber-900 hover:bg-amber-200"
              : "bg-sky-700 text-white hover:bg-sky-800 disabled:opacity-40"
          }`}
        >
          {on ? "Pause" : remaining > 0 ? "Start finding" : "Done"}
        </button>
      </div>

      {aiKeySource === "places" && (
        <p className="mt-2 rounded-lg bg-accent-50 px-3 py-2 text-xs text-accent-700">
          One click from far higher coverage: the AI engine can reuse your Google Places key, but the
          <strong> Gemini API</strong> isn’t enabled on that project yet. Enable “Generative Language API” in the
          Google Cloud console (or set a dedicated <code className="rounded bg-accent-100 px-1">GEMINI_API_KEY</code>),
          then restart. Until then it runs on the free engine (credentialed business names only).
        </p>
      )}
      {aiKeySource === "none" && (
        <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Running on the free engine (credentialed business names only). For a real first name on far more
          businesses, set <code className="rounded bg-slate-200 px-1">GEMINI_API_KEY</code> to turn on the AI engine,
          then restart.
        </p>
      )}

      {on && (
        <p className="mt-2 flex items-center gap-2 text-xs font-medium text-sky-700">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-sky-500" aria-hidden />
          {working ? "Checking a batch…" : "Running…"} names appear below and in the list as they’re found.
        </p>
      )}

      {feed.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-sm">
          {feed.map((f, i) => (
            <li key={`${f.business}-${i}`} className="flex items-center gap-2" title={f.evidence || undefined}>
              <span aria-hidden className="text-emerald-600">✓</span>
              <span className="font-medium text-slate-800">{f.business}</span>
              <span className="text-slate-400">→</span>
              <span className="font-semibold text-emerald-700">Hi {f.firstName},</span>
              <span className="ml-auto rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500">
                {f.source}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
