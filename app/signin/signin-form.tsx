"use client";

import { useState } from "react";

type State =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "sent"; devLink?: string }
  | { phase: "error"; message: string };

export function SignInForm() {
  const [state, setState] = useState<State>({ phase: "idle" });

  return (
    <form
      className="mt-8"
      onSubmit={async (e) => {
        e.preventDefault();
        if (state.phase === "sending") return;
        const email = new FormData(e.currentTarget).get("email");
        setState({ phase: "sending" });
        const controller = new AbortController();
        const deadline = window.setTimeout(() => controller.abort(), 15_000);
        try {
          const res = await fetch("/api/auth/request", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email }),
            signal: controller.signal,
          });
          const body = (await res.json().catch(() => null)) as {
            ok?: boolean;
            error?: string;
            devLink?: string;
          } | null;
          if (res.ok && body?.ok) {
            setState({ phase: "sent", devLink: body.devLink });
          } else {
            setState({
              phase: "error",
              message: body?.error ?? "Something went wrong. Please try again.",
            });
          }
        } catch (err) {
          console.error("[signin] request failed:", err);
          setState({ phase: "error", message: "Could not reach the server. Please try again." });
        } finally {
          window.clearTimeout(deadline);
        }
      }}
    >
      {state.phase === "sent" ? (
        <div role="status" className="rounded-xl border border-sky-200 bg-sky-50 p-5">
          <p className="font-medium text-sky-900">Check your email.</p>
          <p className="mt-1 text-sm text-sky-800">
            We sent a sign-in link. It expires in 15 minutes.
          </p>
          {state.devLink && (
            <a
              href={state.devLink}
              className="mt-3 inline-block rounded-lg bg-sky-900 px-4 py-2 text-sm font-semibold text-white"
            >
              Dev mode: open sign-in link
            </a>
          )}
        </div>
      ) : (
        <>
          <label htmlFor="email" className="block text-sm font-medium text-slate-700">
            Email address
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@yourbusiness.com"
            className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-600/20"
          />
          {state.phase === "error" && (
            <p role="alert" className="mt-3 text-sm font-medium text-red-700">
              {state.message}
            </p>
          )}
          <button
            type="submit"
            disabled={state.phase === "sending"}
            aria-busy={state.phase === "sending"}
            className="mt-4 w-full cursor-pointer rounded-xl bg-sky-900 px-4 py-3 font-semibold text-white transition-colors duration-200 hover:bg-sky-800 disabled:opacity-60"
          >
            {state.phase === "sending" ? "Sending link…" : "Email me a sign-in link"}
          </button>
        </>
      )}
    </form>
  );
}
