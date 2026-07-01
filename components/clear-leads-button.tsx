"use client";

import { useState } from "react";
import { deleteAllLeadsAction } from "@/lib/actions";

/* Destructive "clear all leads" control. Two-step: the button reveals an inline
   confirm so a wipe is never one accidental click. The confirm submits the
   account-scoped server action. */
export function ClearLeadsButton({ count }: { count: number }) {
  const [confirming, setConfirming] = useState(false);
  if (count === 0) return null;

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
      >
        🗑 Clear all leads
      </button>
    );
  }

  return (
    <form action={deleteAllLeadsAction} className="flex items-center gap-2">
      <span className="text-sm font-medium text-red-700">Delete all {count}?</span>
      <button
        type="submit"
        className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700"
      >
        Yes, delete
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-800"
      >
        Cancel
      </button>
    </form>
  );
}
