"use client";

import { useRef, useState, type ChangeEvent } from "react";
import type { StudioMode } from "./studio-types";
import { useLanguage } from "./LanguageContext";

interface InputPanelProps {
  topic: string;
  onTopicChange: (v: string) => void;
  wordTarget: number;
  onWordTargetChange: (v: number) => void;
  minimumFootnotes: number;
  minimumSources: number;
  onMinimumFootnotesChange: (v: number) => void;
  onMinimumSourcesChange: (v: number) => void;
  instructionText: string;
  onInstructionChange: (v: string) => void;
  mode: StudioMode;
  onModeChange: (m: StudioMode) => void;
  onParsedText: (appendedText: string, note: string) => void;
  onGenerateOutline: () => void;
  onGatherSources: () => void;
  onDraftEssay: () => void;
  onOneShot: () => void;
  outlineBusy: boolean;
  sourcesBusy: boolean;
  draftBusy: boolean;
  hasOutline: boolean;
  hasSources: boolean;
  outlineApproved: boolean;
  sourcesApproved: boolean;
  topicError?: string | null;
  instructionError?: string | null;
}

type ParseStatus = "idle" | "busy" | "done" | "error";

const inputClass =
  "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 shadow-sm transition focus:border-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-700/20 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-500 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100 dark:placeholder:text-stone-500 dark:disabled:bg-stone-800/50 dark:disabled:text-stone-500 dark:focus:border-emerald-500";

const primaryBtn =
  "inline-flex w-full items-center justify-center rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500 dark:bg-emerald-700 dark:hover:bg-emerald-600 dark:disabled:bg-stone-800 dark:disabled:text-stone-500";

const secondaryBtn =
  "inline-flex w-full items-center justify-center rounded-lg border border-stone-300 bg-white px-4 py-2.5 text-sm font-semibold text-stone-800 shadow-sm transition hover:border-emerald-700 hover:text-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:text-stone-400 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200 dark:hover:border-emerald-500 dark:hover:text-emerald-300 dark:disabled:text-stone-600";

function Step({ index, label, state }: { index: number; label: string; state: "done" | "now" | "todo" }) {
  const dot =
    state === "done"
      ? "bg-emerald-800 text-white dark:bg-emerald-700"
      : state === "now"
        ? "border-2 border-emerald-800 bg-white text-emerald-900 dark:border-emerald-500 dark:bg-stone-900 dark:text-emerald-400"
        : "border border-stone-300 bg-white text-stone-400 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-500";
  return (
    <li className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${dot}`}
      >
        {state === "done" ? "✓" : index}
      </span>
      <span className={`text-xs font-medium ${state === "todo" ? "text-stone-400 dark:text-stone-500" : "text-stone-800 dark:text-stone-200"}`}>
        {label}
      </span>
    </li>
  );
}

export default function InputPanel(props: InputPanelProps) {
  const { t, formatNumber } = useLanguage();
  const {
    topic,
    onTopicChange,
    wordTarget,
    onWordTargetChange,
    instructionText,
    onInstructionChange,
    mode,
    onModeChange,
    onParsedText,
    onGenerateOutline,
    onGatherSources,
    onDraftEssay,
    onOneShot,
    outlineBusy,
    sourcesBusy,
    draftBusy,
    hasOutline,
    hasSources,
    outlineApproved,
    sourcesApproved,
    topicError,
    instructionError,
  } = props;

  const fileRef = useRef<HTMLInputElement>(null);
  const attachId = useRef(0);
  const [parseStatus, setParseStatus] = useState<ParseStatus>("idle");
  const [parseNote, setParseNote] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<
    Array<{ id: number; name: string; kind: string; previewUrl: string | null; addedText: string }>
  >([]);

  const busy = outlineBusy || sourcesBusy || draftBusy;

  const ACCEPT_RE = /\.(docx|pdf|txt|md|png|jpe?g|webp|gif)$/i;

  function removeAttachment(id: number) {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) {
        if (target.previewUrl) URL.revokeObjectURL(target.previewUrl);
        // Best effort: pull its text back out of Context.
        if (target.addedText && instructionText.includes(target.addedText)) {
          onInstructionChange(
            instructionText.replace(target.addedText, "").replace(/\n{3,}/g, "\n\n").trim(),
          );
        }
      }
      return prev.filter((a) => a.id !== id);
    });
  }

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []).slice(0, 5);
    if (picked.length === 0) return;
    setFileError(null);
    const bad = picked.find((f) => !ACCEPT_RE.test(f.name));
    if (bad) {
      setFileError(t("invalidFileType", { name: bad.name }));
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setParseStatus("busy");
    setParseNote(null);
    try {
      // Thumbnails for images, shown while the server reads the files.
      const thumbs = new Map<string, string>();
      for (const f of picked) {
        if (/^image\//.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name)) {
          thumbs.set(f.name, URL.createObjectURL(f));
        }
      }
      const form = new FormData();
      for (const f of picked) form.append("files", f);
      const res = await fetch("/api/parse-is", { method: "POST", body: form });
      const data = (await res.json().catch(() => ({}))) as {
        combinedText?: string;
        items?: Array<{ filename: string; kind: string; text: string; pages: number }>;
        errors?: Array<{ filename: string; error: string }>;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `Could not read those files (${res.status}).`);
      const items = data.items ?? [];
      const combined = data.combinedText ?? "";
      if (combined) {
        onParsedText(combined, "");
        const chunks = items.length > 0 ? items : picked.map((f) => ({ filename: f.name, kind: "text", text: combined, pages: 0 }));
        // Split the combined text back per item for removal (headers are stable).
        let rest = combined;
        const next: typeof attachments = chunks.map((it) => {
          const head = `--- From ${it.filename} ---\n`;
          let block = "";
          const at = rest.indexOf(head);
          if (at !== -1) {
            const nx = rest.indexOf("--- From ", at + head.length);
            block = nx !== -1 ? rest.slice(at, nx).trimEnd() : rest.slice(at);
            rest = nx !== -1 ? rest.slice(nx) : "";
          } else {
            block = rest;
            rest = "";
          }
          attachId.current += 1;
          return {
            id: attachId.current,
            name: it.filename,
            kind: it.kind,
            previewUrl: thumbs.get(it.filename) ?? null,
            addedText: block,
          };
        });
        setAttachments((prev) => [...prev, ...next]);
      }
      const okNames = items.map((it) => it.filename).join(", ");
      const errNote = (data.errors ?? []).map((er) => `${er.filename}: ${er.error}`).join(" ");
      setParseStatus("done");
      setParseNote(
        t("filesAddedNote", {
          names: okNames || t("filesLabel"),
          skipped: errNote ? t("skippedFiles", { errors: errNote }) : "",
        }),
      );
    } catch (err) {
      setParseStatus("error");
      setFileError(err instanceof Error ? err.message : t("fileReadError"));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const canOutline = topic.trim().length > 0;
  const canSources = hasOutline && outlineApproved;
  const canDraft = hasSources && sourcesApproved;

  return (
    <div className="flex flex-col gap-5">
      {/* Progress */}
      <nav aria-label={t("stepContext")}>
        <ol className="grid grid-cols-2 gap-2">
          <Step index={1} label={t("stepContext")} state={canOutline ? "done" : "now"} />
          <Step index={2} label={t("stepOutline")} state={hasOutline ? (outlineApproved ? "done" : "now") : "todo"} />
          <Step index={3} label={t("stepSources")} state={hasSources ? (sourcesApproved ? "done" : "now") : "todo"} />
          <Step index={4} label={t("stepDraft")} state={props.hasOutline && hasSources && outlineApproved && sourcesApproved ? "now" : "todo"} />
        </ol>
      </nav>

      {/* Mode toggle */}
      <div>
        <span id="mode-label" className="mb-1 block text-sm font-semibold text-stone-900 dark:text-stone-100">
          {t("workflowMode")}
        </span>
        <div
          role="group"
          aria-labelledby="mode-label"
          className="grid grid-cols-2 gap-1 rounded-lg border border-stone-300 bg-stone-200/60 p-1 dark:border-stone-700 dark:bg-stone-800/80"
        >
          {(["staged", "one-shot"] as StudioMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onModeChange(m)}
              aria-pressed={mode === m}
              className={`rounded-md px-3 py-1.5 text-sm font-semibold transition active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 ${
                mode === m
                  ? "bg-white text-emerald-900 shadow-sm dark:bg-stone-900 dark:text-emerald-400"
                  : "text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200"
              }`}
            >
              {m === "staged" ? t("modeStaged") : t("modeOneShot")}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs leading-5 text-stone-600 dark:text-stone-400">
          {mode === "staged" ? t("modeStagedHelp") : t("modeOneShotHelp")}
        </p>
      </div>

      {/* Topic */}
      <div>
        <label htmlFor="topic" className="mb-1 block text-sm font-semibold text-stone-900 dark:text-stone-100">
          {t("topicLabel")}
        </label>
        <input
          id="topic"
          type="text"
          value={topic}
          onChange={(e) => onTopicChange(e.target.value)}
          placeholder={t("topicPlaceholder")}
          maxLength={500}
          aria-describedby="topic-help"
          aria-invalid={Boolean(topicError)}
          className={inputClass}
        />
        <p id="topic-help" className="mt-1 text-xs leading-5 text-stone-600 dark:text-stone-400">
          {t("topicHelp")}
        </p>
        {topicError ? (
          <p role="alert" className="mt-1 text-xs font-medium text-red-800 dark:text-red-400">
            {topicError}
          </p>
        ) : null}
      </div>

      {/* Word target */}
      <div>
        <label htmlFor="word-target" className="mb-1 block text-sm font-semibold text-stone-900 dark:text-stone-100">
          {t("wordTargetLabel")}
        </label>
        <div className="flex items-center gap-3">
          <input
            id="word-target"
            type="range"
            min={400}
            max={3000}
            step={100}
            value={wordTarget}
            onChange={(e) => onWordTargetChange(Number(e.target.value))}
            aria-describedby="word-target-help"
            className="w-full accent-emerald-800 dark:accent-emerald-500"
          />
          <output htmlFor="word-target" className="w-20 shrink-0 rounded-md bg-stone-200/70 px-2 py-1 text-center text-sm font-bold text-stone-900 dark:bg-stone-800 dark:text-stone-100">
            {formatNumber(wordTarget)}
          </output>
        </div>
        <p id="word-target-help" className="mt-1 text-xs leading-5 text-stone-600 dark:text-stone-400">
          {t("wordTargetHelp")}
        </p>
      </div>

      {/* Context upload */}
      {[
        { id: "minimum-footnotes", label: t("minimumFootnotesLabel"), value: props.minimumFootnotes, max: 30, change: props.onMinimumFootnotesChange, help: t("minimumFootnotesHelp") },
        { id: "minimum-sources", label: t("minimumSourcesLabel"), value: props.minimumSources, max: 18, change: props.onMinimumSourcesChange, help: t("minimumSourcesHelp") },
      ].map((setting) => (
        <div key={setting.id}>
          <label htmlFor={setting.id} className="mb-1 block text-sm font-semibold text-stone-900 dark:text-stone-100">{setting.label}</label>
          <div className="flex items-center gap-3">
            <input id={setting.id} type="range" min={1} max={setting.max} step={1} value={setting.value} disabled={busy} onChange={(event) => setting.change(Number(event.target.value))} aria-describedby={`${setting.id}-help`} className="w-full accent-emerald-800 dark:accent-emerald-500" />
            <output htmlFor={setting.id} className="w-20 shrink-0 rounded-md bg-stone-200/70 px-2 py-1 text-center text-sm font-bold text-stone-900 dark:bg-stone-800 dark:text-stone-100">{setting.value}</output>
          </div>
          <p id={`${setting.id}-help`} className="mt-1 text-xs leading-5 text-stone-600 dark:text-stone-400">{setting.help}</p>
        </div>
      ))}

      <div>
        <label htmlFor="is-file" className="mb-1 block text-sm font-semibold text-stone-900 dark:text-stone-100">
          {t("filesLabel")}
        </label>
        <input
          ref={fileRef}
          id="is-file"
          type="file"
          multiple
          accept=".docx,.pdf,.txt,.md,.png,.jpg,.jpeg,.webp,.gif"
          onChange={handleFile}
          disabled={busy}
          aria-describedby="is-file-help"
          className="block w-full cursor-pointer rounded-lg border border-dashed border-stone-300 bg-white px-3 py-2 text-sm text-stone-700 file:mr-3 file:rounded-md file:border-0 file:bg-emerald-800 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-white hover:file:bg-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300 dark:file:bg-emerald-700 dark:hover:file:bg-emerald-600"
        />
        <p id="is-file-help" className="mt-1 text-xs leading-5 text-stone-600 dark:text-stone-400">
          {t("filesHelp")}
        </p>
        {attachments.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1.5" aria-label={t("filesLabel")}>
            {attachments.map((a) => (
              <li
                key={a.id}
                className="flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-2 py-1.5 shadow-sm dark:border-stone-700 dark:bg-stone-800"
              >
                {a.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.previewUrl} alt="" className="h-9 w-9 shrink-0 rounded-md border border-stone-200 object-cover dark:border-stone-700" />
                ) : (
                  <span
                    aria-hidden="true"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-stone-200 text-xs font-bold text-stone-600 dark:bg-stone-700 dark:text-stone-300"
                  >
                    {a.kind === "image" ? "IMG" : "DOC"}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-stone-800 dark:text-stone-200" title={a.name}>
                  {a.name}
                </span>
                <span className="shrink-0 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stone-600 dark:bg-stone-700 dark:text-stone-300">
                  {a.kind === "image" ? t("fileKindPicture") : t("fileKindFile")}
                </span>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  aria-label={t("removeFile", { name: a.name })}
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-sm font-bold text-stone-500 transition hover:bg-stone-100 hover:text-stone-800 dark:text-stone-400 dark:hover:bg-stone-700 dark:hover:text-stone-200 active:scale-[0.98]"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {parseStatus === "busy" ? (
          <div aria-live="polite" className="mt-2 space-y-1.5">
            <div className="h-2.5 w-3/4 animate-pulse rounded bg-stone-200 dark:bg-stone-700" />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-stone-200 dark:bg-stone-700" />
            <p className="text-xs text-stone-600 dark:text-stone-400">{t("readingFiles")}</p>
          </div>
        ) : null}
        {parseNote ? (
          <p aria-live="polite" className="mt-1 text-xs font-medium text-emerald-900 dark:text-emerald-300">
            {parseNote}
          </p>
        ) : null}
        {fileError ? (
          <p role="alert" className="mt-1 text-xs font-medium text-red-800 dark:text-red-400">
            {fileError}
          </p>
        ) : null}
      </div>

      {/* Context text */}
      <div>
        <label htmlFor="instruction-text" className="mb-1 block text-sm font-semibold text-stone-900 dark:text-stone-100">
          {t("contextLabel")} <span className="font-normal text-stone-500 dark:text-stone-400">{t("contextOptional")}</span>
        </label>
        <textarea
          id="instruction-text"
          value={instructionText}
          onChange={(e) => onInstructionChange(e.target.value)}
          rows={7}
          placeholder={t("contextPlaceholder")}
          aria-describedby="instruction-help"
          aria-invalid={Boolean(instructionError)}
          className={`${inputClass} resize-y leading-6`}
        />
        <p id="instruction-help" className="mt-1 text-xs leading-5 text-stone-600 dark:text-stone-400">
          {t("contextHelp", { count: formatNumber(instructionText.length) })}
        </p>
        {instructionError ? (
          <p role="alert" className="mt-1 text-xs font-medium text-red-800 dark:text-red-400">
            {instructionError}
          </p>
        ) : null}
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2 border-t border-stone-200 pt-4 dark:border-stone-800">
        {mode === "staged" ? (
          <>
            <button type="button" onClick={onGenerateOutline} disabled={!canOutline || outlineBusy} className={primaryBtn}>
              {outlineBusy ? t("writingOutline") : t("generateOutline")}
            </button>
            {!canOutline ? (
              <p className="text-xs leading-5 text-stone-600 dark:text-stone-400">{t("topicErrorButton")}</p>
            ) : null}
            <button type="button" onClick={onGatherSources} disabled={!canSources || sourcesBusy} className={secondaryBtn}>
              {sourcesBusy ? t("gatheringSources") : t("gatherSources")}
            </button>
            {hasOutline && !outlineApproved ? (
              <p className="text-xs leading-5 text-amber-900 dark:text-amber-300">{t("approveOutlineFirst")}</p>
            ) : null}
            <button type="button" onClick={onDraftEssay} disabled={!canDraft || draftBusy} className={secondaryBtn}>
              {draftBusy ? t("draftingEssay") : t("draftEssay")}
            </button>
            {hasSources && !sourcesApproved ? (
              <p className="text-xs leading-5 text-amber-900 dark:text-amber-300">{t("approveSourcesFirst")}</p>
            ) : null}
          </>
        ) : (
          <>
            <button type="button" onClick={onOneShot} disabled={!canOutline || busy} className={primaryBtn}>
              {busy ? t("writingEssay") : t("generateEssay")}
            </button>
            {!canOutline ? (
              <p className="text-xs leading-5 text-stone-600 dark:text-stone-400">{t("topicErrorButton")}</p>
            ) : (
              <p className="text-xs leading-5 text-stone-600 dark:text-stone-400">{t("oneShotHelp")}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
