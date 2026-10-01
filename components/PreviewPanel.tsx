"use client";

import { useEffect, useState } from "react";
import DocxPaper from "./DocxPaper";
import RefineChat from "./RefineChat";
import { type DraftResult, type EssayDraft, type VersionEntry } from "./studio-types";
import { useLanguage } from "./LanguageContext";

interface PreviewPanelProps {
  entry: VersionEntry | null;
  versions: VersionEntry[];
  onSelectVersion: (id: string) => void;
  wordTarget: number;
  minimumFootnotes: number;
  minimumSources: number;
  projectId: string | null;
  draftBusy: boolean;
  onRefined: (result: DraftResult) => void;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-stone-100 px-3 py-2 text-center dark:bg-stone-800/70">
      <p className="text-lg font-bold leading-7 text-stone-900 dark:text-stone-100">{value}</p>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-600 dark:text-stone-400">{label}</p>
    </div>
  );
}

export default function PreviewPanel({
  entry,
  versions,
  onSelectVersion,
  wordTarget,
  minimumFootnotes,
  minimumSources,
  projectId,
  draftBusy,
  onRefined,
}: PreviewPanelProps) {
  const { t, formatNumber } = useLanguage();
  const [blobResult, setBlobResult] = useState<{ id: string; blob: Blob } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draftResult, setDraftResult] = useState<{ id: string; draft: EssayDraft } | null>(null);

  const downloadUrl = entry?.downloadUrl ?? null;
  const entryId = entry?.id ?? null;
  const blob = blobResult?.id === entryId ? blobResult?.blob ?? null : null;
  const loadedDraft = entry?.draft ?? (draftResult?.id === entryId ? draftResult?.draft ?? null : null);
  const expanded = entryId !== null && expandedId === entryId;
  const setExpanded = (open: boolean) => setExpandedId(open ? entryId : null);

  // Fetch the .docx blob once per version.
  useEffect(() => {
    if (!entry || !downloadUrl) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error(`Preview request failed (${res.status}).`);
        const b = await res.blob();
        if (!cancelled) setBlobResult({ id: entry.id, blob: b });
      } catch {
        // Empty blob drives DocxPaper into its error/fallback path.
        if (!cancelled) setBlobResult({ id: entry.id, blob: new Blob() });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry, downloadUrl]);

  // Full draft JSON: present for fresh drafts, fetched for history entries.
  useEffect(() => {
    if (!entry) {
      return;
    }
    if (entry.draft) {
      return;
    }
    let cancelled = false;
    fetch(`/api/versions/${entry.id}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && d.draft && Array.isArray(d.draft.footnotes)) setDraftResult({ id: entry.id, draft: d.draft });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [entry]);

  // Esc closes the overlay; lock background scroll while open.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpandedId(null);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [expanded]);

  const progress = entry && wordTarget > 0 ? Math.min(100, Math.round((entry.wordCount / wordTarget) * 100)) : 0;

  const fallback = loadedDraft ? (
    <article className="essay-fallback-serif mx-auto max-w-2xl rounded-sm border border-stone-200 bg-white p-6 break-words text-stone-900 shadow-md sm:p-10">
      <h3 className="mt-3 text-center text-xl font-bold">{loadedDraft.title}</h3>
      {loadedDraft.introduction.map((p, i) => (
        <p key={`i-${i}`}>{p}</p>
      ))}
      {loadedDraft.sections.map((s, i) => (
        <div key={`s-${i}`}>
          {s.heading ? <h4 className="font-bold">{s.heading}</h4> : null}
          {s.paragraphs.map((p, j) => (
            <p key={`s-${i}-${j}`}>{p}</p>
          ))}
        </div>
      ))}
      {loadedDraft.conclusion.map((p, i) => (
        <p key={`c-${i}`}>{p}</p>
      ))}
      {loadedDraft.footnotes.length > 0 ? (
        <div className="footnotes">
          <hr />
          <ol>
            {loadedDraft.footnotes.map((f) => (
              <li key={f.id}>
                {f.author ? `${f.author}, ` : ""}“{f.title}”{f.publisher ? `, ${f.publisher}` : ""}
                {f.year ? ` (${f.year})` : ""}.{f.url ? ` ${f.url}` : ""}
                {f.accessed ? ` ${t("accessedDate", { date: f.accessed })}` : ""}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {loadedDraft.worksCited.length > 0 ? (
        <div>
          <h4 className="text-center font-bold">Works Cited</h4>
          {loadedDraft.worksCited.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      ) : null}
    </article>
  ) : null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Stats */}
      <section aria-labelledby="preview-stats" className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm transition-colors duration-150 dark:border-stone-800 dark:bg-stone-900/80">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="preview-stats" className="text-base font-bold text-stone-900 dark:text-stone-100">
            {t("previewHeading")}
          </h2>
          {versions.length > 0 ? (
            <div className="flex items-center gap-2">
              <label htmlFor="version-select" className="text-xs font-semibold text-stone-600 dark:text-stone-400">
                {t("versionLabel")}
              </label>
              <select
                id="version-select"
                value={entry?.id ?? ""}
                onChange={(e) => onSelectVersion(e.target.value)}
                className="max-w-44 truncate rounded-md border border-stone-300 bg-white px-2 py-1 text-xs font-semibold text-stone-800 shadow-sm focus:border-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-700/20 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200"
              >
                {[...versions].reverse().map((v) => (
                  <option key={v.id} value={v.id}>
                    {t("versionOption", { version: v.version, words: formatNumber(v.wordCount) })}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>

        {entry ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Stat label={t("statWords")} value={formatNumber(entry.wordCount)} />
              <Stat label={t("statFootnotes")} value={formatNumber(entry.footnoteCount)} />
              <Stat label={t("statWorksCited")} value={formatNumber(loadedDraft?.worksCited.length ?? entry.worksCitedCount)} />
            </div>
            <div className="mt-3">
              <div className="flex items-center justify-between text-xs font-medium text-stone-600 dark:text-stone-400">
                <span>{t("targetWords", { target: formatNumber(wordTarget) })}</span>
                <span>{progress}%</span>
              </div>
              <div
                className="mt-1 h-2 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800"
                role="progressbar"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={t("progressAria")}
              >
                <div className="h-full rounded-full bg-emerald-800 transition-all dark:bg-emerald-600" style={{ width: `${progress}%` }} />
              </div>
            </div>
            {entry.summary ? <p className="mt-2 text-xs leading-5 text-stone-600 dark:text-stone-400">{entry.summary}</p> : null}
            <a
              href={entry.downloadUrl}
              download
              className="mt-3 inline-flex w-full items-center justify-center rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 active:scale-[0.98] dark:bg-emerald-700 dark:hover:bg-emerald-600"
            >
              {t("downloadDocx")}
            </a>
          </>
        ) : (
          <p className="rounded-lg border border-dashed border-stone-300 bg-stone-50 px-4 py-6 text-center text-xs leading-5 text-stone-600 dark:border-stone-800 dark:bg-stone-900/40 dark:text-stone-400">
            {t("previewBlankPlaceholder")}
          </p>
        )}
      </section>

      {/* Paper */}
      <section aria-label={t("pagePreviewHeading")} className="min-w-0 rounded-xl border border-stone-200 bg-white p-4 shadow-sm transition-colors duration-150 dark:border-stone-800 dark:bg-stone-900/80">
        <DocxPaper
          blob={blob}
          draftBusy={draftBusy}
          fallback={fallback}
          onExpand={blob && blob.size > 0 ? () => setExpanded(true) : undefined}
        />
      </section>

      {/* Footnotes (full citations live here — tap a number in the text to jump down) */}
      {loadedDraft && loadedDraft.footnotes.length > 0 ? (
        <section
          aria-labelledby="footnotes-heading"
          className="min-w-0 rounded-xl border border-stone-200 bg-white p-4 shadow-sm transition-colors duration-150 dark:border-stone-800 dark:bg-stone-900/80"
        >
          <h2 id="footnotes-heading" className="mb-1 text-base font-bold text-stone-900 dark:text-stone-100">
            {t("footnotesHeading")}
            <span className="ml-2 rounded-full bg-stone-100 px-2 py-0.5 text-xs font-semibold text-stone-600 dark:bg-stone-800 dark:text-stone-300">
              {formatNumber(loadedDraft.footnotes.length)}
            </span>
          </h2>
          <p className="mb-2 text-xs text-stone-500 dark:text-stone-400">{t("footnotesTapHint")}</p>
          <ol className="flex flex-col gap-2.5">
            {[...loadedDraft.footnotes]
              .sort((a, b) => a.id - b.id)
              .map((f) => (
                <li
                  key={f.id}
                  id={`fn-${f.id}`}
                  className="min-w-0 scroll-mt-24 rounded-lg bg-stone-50 p-2.5 text-xs leading-5 text-stone-700 dark:bg-stone-800/50 dark:text-stone-300"
                >
                  <sup className="mr-1.5 font-bold text-stone-900 dark:text-stone-100">{f.id}</sup>
                  <span>
                    {f.author}
                    {f.title ? (
                      <>
                        {f.author ? ", " : ""}
                        <em>{f.title}</em>
                      </>
                    ) : null}
                    {f.publisher || f.year ? (
                      <> ({[f.publisher, f.year].filter(Boolean).join(", ")})</>
                    ) : null}
                    {f.url ? (
                      <>
                        {", "}
                        <a
                          href={f.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium break-all text-emerald-800 underline decoration-emerald-800/40 underline-offset-2 hover:text-emerald-900 dark:text-emerald-400 dark:decoration-emerald-400/40 dark:hover:text-emerald-300"
                        >
                          {f.url}
                        </a>
                      </>
                    ) : null}
                    {f.accessed ? ` ${t("accessedDate", { date: f.accessed })}` : null}
                  </span>
                </li>
              ))}
          </ol>
        </section>
      ) : null}

      {/* Refine */}
      <section aria-labelledby="refine-heading" className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm transition-colors duration-150 dark:border-stone-800 dark:bg-stone-900/80">
        <h2 id="refine-heading" className="mb-2 text-base font-bold text-stone-900 dark:text-stone-100">
          {t("keepPromptingHeading")}
        </h2>
        <RefineChat
          minimumFootnotes={minimumFootnotes}
          minimumSources={minimumSources}
          projectId={projectId}
          versionId={entry?.id ?? null}
          version={entry?.version ?? null}
          disabled={!entry}
          onRefined={onRefined}
          targets={[
            ...(entry?.draft ? ["Introduction", ...entry.draft.sections.map((s) => s.heading), "Conclusion"] : []),
          ]}
        />
      </section>

      {/* Expanded overlay */}
      {expanded && blob && blob.size > 0 ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={t("expandedPreviewTitle")}
        >
          <div
            className="absolute inset-0 bg-stone-950/70 backdrop-blur-xs"
            onClick={() => setExpanded(false)}
            aria-hidden="true"
          />
          <div className="relative flex max-h-[92vh] w-[min(1024px,94vw)] flex-col overflow-hidden rounded-2xl border border-stone-200 bg-stone-100 shadow-2xl dark:border-stone-800 dark:bg-stone-950">
            <div className="flex items-center justify-between gap-3 border-b border-stone-200 bg-white px-4 py-2.5 dark:border-stone-800 dark:bg-stone-900">
              <p className="truncate text-sm font-bold text-stone-900 dark:text-stone-100">
                {loadedDraft?.title || entry?.title || t("expandedPreviewTitle")}
              </p>
              <div className="flex shrink-0 items-center gap-2">
                {entry ? (
                  <a
                    href={entry.downloadUrl}
                    download
                    className="inline-flex items-center justify-center rounded-lg bg-emerald-800 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 active:scale-[0.98] dark:bg-emerald-700 dark:hover:bg-emerald-600"
                  >
                    {t("download")}
                  </a>
                ) : null}
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  aria-label={t("closeExpanded")}
                  className="inline-flex items-center justify-center rounded-lg border border-stone-300 bg-white px-3.5 py-1.5 text-sm font-semibold text-stone-700 shadow-sm transition hover:border-stone-400 hover:text-stone-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 active:scale-[0.98] dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300 dark:hover:border-stone-600 dark:hover:text-stone-100"
                >
                  {t("closeExpanded")}
                </button>
              </div>
            </div>
            <div className="overflow-y-auto p-3 sm:p-6">
              <div className="mx-auto max-w-4xl rounded-xl border border-stone-200 bg-white p-3 shadow-sm sm:p-4 dark:border-stone-800 dark:bg-stone-900">
                <DocxPaper blob={blob} draftBusy={false} fallback={fallback} enableMarkerJump={false} />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
