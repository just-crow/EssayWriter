"use client";

import { useState } from "react";
import type { DraftResult } from "./studio-types";

interface RefineChatProps {
  projectId: string | null;
  versionId: string | null;
  disabled: boolean;
  onRefined: (result: DraftResult) => void;
}

interface ChatLine {
  role: "user" | "assistant";
  text: string;
}

export default function RefineChat({ projectId, versionId, disabled, onRefined }: RefineChatProps) {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<ChatLine[]>([]);

  async function send() {
    const text = instruction.trim();
    if (!text) {
      setError("Describe the change first.");
      return;
    }
    if (!projectId) {
      setError("Draft an essay before refining it.");
      return;
    }
    setError(null);
    setBusy(true);
    setLog((prev) => [...prev, { role: "user", text }]);
    try {
      const res = await fetch("/api/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, versionId, instruction: text }),
      });
      const data = (await res.json().catch(() => ({}))) as DraftResult & { error?: string };
      if (!res.ok) throw new Error(data.error || `Refine failed (${res.status}).`);
      const result: DraftResult = {
        ...data,
        worksCitedCount: data.worksCitedCount ?? data.draft.worksCited.length,
      };
      onRefined(result);
      setLog((prev) => [...prev, { role: "assistant", text: result.summary }]);
      setInstruction("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Refine failed.";
      setError(message);
      setLog((prev) => [...prev, { role: "assistant", text: `Could not apply that change: ${message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {log.length > 0 ? (
        <ul aria-live="polite" className="mb-3 flex max-h-44 flex-col gap-2 overflow-y-auto rounded-lg bg-stone-100 p-3">
          {log.map((line, i) => (
            <li
              key={i}
              className={`max-w-[92%] rounded-lg px-3 py-1.5 text-xs leading-5 ${
                line.role === "user"
                  ? "self-end bg-emerald-800 text-white"
                  : "self-start border border-stone-200 bg-white text-stone-800"
              }`}
            >
              {line.text}
            </li>
          ))}
        </ul>
      ) : null}

      <label htmlFor="refine-input" className="mb-1 block text-sm font-semibold text-stone-900">
        Refine draft
      </label>
      <textarea
        id="refine-input"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        rows={3}
        disabled={disabled || busy}
        placeholder={
          disabled ? "Your draft will appear above — then ask for changes here…" : "e.g. Soften the tone of paragraph two…"
        }
        aria-describedby="refine-help"
        className="w-full resize-y rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm leading-6 text-stone-900 shadow-sm transition placeholder:text-stone-400 focus:border-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-700/20 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-500"
      />
      <p id="refine-help" className="mt-1 text-xs leading-5 text-stone-600">
        Each revision saves a new version.
      </p>
      {error ? (
        <p role="alert" className="mt-1 text-xs font-medium text-red-800">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        onClick={send}
        disabled={disabled || busy || instruction.trim().length === 0}
        className="mt-2 inline-flex items-center justify-center rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500"
      >
        {busy ? "Revising…" : "Send"}
      </button>
    </div>
  );
}
