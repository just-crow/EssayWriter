"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import InputPanel from "@/components/InputPanel";
import PipelinePanel from "@/components/PipelinePanel";
import PreviewPanel from "@/components/PreviewPanel";
import LanguageSwitch from "@/components/LanguageSwitch";
import ThemeSwitch from "@/components/ThemeSwitch";
import { useLanguage } from "@/components/LanguageContext";
import {
  toVersionEntry,
  type DraftResult,
  type EssayStructure,
  type HistoryProject,
  type SourceItem,
  type ValidationIssue,
  type VersionEntry,
} from "@/components/studio-types";

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

/** Ticks every second while `active`, returning elapsed whole seconds.
 * Pure client-side proof of life for long synchronous requests. */
function useElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) {
      return;
    }
    const start = Date.now();
    const reset = setTimeout(() => setElapsed(0), 0);
    const id = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000);
    return () => { clearTimeout(reset); clearInterval(id); };
  }, [active]);
  return active ? elapsed : 0;
}

export default function StudioPage() {
  const { t } = useLanguage();

  // Context state
  const [topic, setTopic] = useState("");
  const [wordTarget, setWordTarget] = useState(1200);
  const [minimumFootnotes, setMinimumFootnotes] = useState(6);
  const [minimumSources, setMinimumSources] = useState(3);
  useEffect(() => {
    const restore = setTimeout(() => {
      try {
        const settings = JSON.parse(localStorage.getItem("essaywriter:citation-minimums") || "null");
        if (Number.isInteger(settings?.minimumFootnotes) && settings.minimumFootnotes >= 1 && settings.minimumFootnotes <= 30) setMinimumFootnotes(settings.minimumFootnotes);
        if (Number.isInteger(settings?.minimumSources) && settings.minimumSources >= 1 && settings.minimumSources <= 18) setMinimumSources(settings.minimumSources);
      } catch { /* Invalid saved preferences use the defaults. */ }
    }, 0);
    return () => clearTimeout(restore);
  }, []);
  const updateCitationMinimums = (footnotes: number, works: number) => {
    setMinimumFootnotes(footnotes);
    setMinimumSources(works);
    try { localStorage.setItem("essaywriter:citation-minimums", JSON.stringify({ minimumFootnotes: footnotes, minimumSources: works })); } catch { /* Preferences still apply for this session. */ }
  };
  const [instructionText, setInstructionText] = useState("");
  const [mode, setMode] = useState<"staged" | "one-shot">("staged");

  // Project state
  const [projectId, setProjectId] = useState<string | null>(null);
  const [structure, setStructure] = useState<EssayStructure | null>(null);
  const [structureEdited, setStructureEdited] = useState(false);
  const [outlineApproved, setOutlineApproved] = useState(false);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [liveSearchUsed, setLiveSearchUsed] = useState<boolean | null>(null);
  const [liveHits, setLiveHits] = useState(0);
  const [sourcesApproved, setSourcesApproved] = useState(false);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  // Loading + errors
  const [outlineBusy, setOutlineBusy] = useState(false);
  const [sourcesBusy, setSourcesBusy] = useState(false);
  const [draftBusy, setDraftBusy] = useState(false);
  // In-flight locks: state lags a render, so rapid re-clicks would otherwise
  // fire duplicate model requests. Refs guard the actual work.
  const inflight = useRef({ outline: false, sources: false, draft: false, oneShot: false });
  const [topicError, setTopicError] = useState<string | null>(null);
  const [instructionError, setInstructionError] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);

  // History via /api/projects, scoped to IDs this browser created.
  // Stored locally so one visitor never sees another's essays.
  const [history, setHistory] = useState<HistoryProject[]>([]);
  const [historyNote, setHistoryNote] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("essaywriter:project-ids");
      const ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];
      if (!Array.isArray(ids) || ids.length === 0) {
        return;
      }
      (async () => {
        try {
          const res = await fetch(`/api/projects?ids=${encodeURIComponent(ids.slice(0, 100).join(","))}`);
          const data = (await res.json().catch(() => ({}))) as { projects?: HistoryProject[] };
          if (!res.ok) throw new Error("History unavailable.");
          setHistory(data.projects ?? []);
        } catch {
          setHistoryNote(t("historyUnavailable"));
        }
      })();
    } catch {
      // The initial empty history already handles malformed local storage.
    }
  }, [t]);

  // Remember every project this browser creates for future history lookups.
  useEffect(() => {
    if (!projectId) return;
    try {
      const raw = localStorage.getItem("essaywriter:project-ids");
      const ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];
      if (!Array.isArray(ids)) return;
      if (!ids.includes(projectId)) {
        localStorage.setItem(
          "essaywriter:project-ids",
          JSON.stringify([projectId, ...ids].slice(0, 100))
        );
      }
    } catch {
      // private mode etc: history just won't persist
    }
  }, [projectId]);

  const selectedEntry = versions.find((v) => v.id === selectedVersionId) ?? versions[versions.length - 1] ?? null;
  const latestIssues: ValidationIssue[] = selectedEntry?.issues ?? [];
  const coverage = selectedEntry?.draft?.coverage ?? [];
  const projectTitle =
    selectedEntry?.draft?.title || selectedEntry?.title || topic.trim() || t("untitledEssay");

  function validateContext(): boolean {
    if (!topic.trim()) {
      setTopicError(t("topicErrorRequired"));
      return false;
    }
    setTopicError(null);
    setInstructionError(null);
    return true;
  }

  const generateOutline = useCallback(async () => {
    if (!validateContext() || outlineBusy || inflight.current.outline) return;
    inflight.current.outline = true;
    setGlobalError(null);
    setOutlineBusy(true);
    try {
      const data = await postJSON<{ projectId: string; structure: EssayStructure }>("/api/structure", {
        topic: topic.trim(),
        instructionText: instructionText.trim(),
        extraInstructions: "",
        wordTarget,
        projectId: projectId ?? undefined,
      });
      setProjectId(data.projectId);
      setStructure(data.structure);
      setStructureEdited(false);
      setOutlineApproved(false);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : t("outlineFailed"));
    } finally {
      inflight.current.outline = false;
      setOutlineBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, instructionText, wordTarget, projectId, outlineBusy, t]);

  /** Shared apply step for both source-response shapes:
   * { jobId } -> poll to completion; { sources, ... } -> already final
   * (serverless mode runs the pipeline synchronously). */
  const applySources = (result: {
    sources: SourceItem[];
    liveSearchUsed: boolean;
    liveHits: number;
  }) => {
    setSources(result.sources);
    setLiveSearchUsed(result.liveSearchUsed);
    setLiveHits(result.liveHits);
    setSourcesApproved(false);
  };

  const gatherSources = useCallback(async () => {
    if (!structure || sourcesBusy || inflight.current.sources) return;
    inflight.current.sources = true;
    setGlobalError(null);
    setSourcesBusy(true);
    try {
      const data = await postJSON<{
        sources: SourceItem[];
        liveSearchUsed: boolean;
        liveHits: number;
      }>("/api/sources", {
        topic: topic.trim(),
        structureJson: JSON.stringify(structure),
        projectId: projectId ?? undefined,
        needed: 18,
      });
      applySources(data);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : t("sourcesFailed"));
    } finally {
      inflight.current.sources = false;
      setSourcesBusy(false);
    }
  }, [structure, topic, projectId, sourcesBusy, t]);

  const draftEssay = useCallback(async () => {
    if (!structure || sources.length === 0 || draftBusy || inflight.current.draft) return;
    inflight.current.draft = true;
    setGlobalError(null);
    setDraftBusy(true);
    try {
      const data = await postJSON<DraftResult & { error?: string }>("/api/draft", {
        minimumFootnotes,
        minimumSources,
        topic: topic.trim(),
        instructionText: instructionText.trim(),
        extraInstructions: "",
        wordTarget,
        structureJson: JSON.stringify(structure),
        sourcesJson: JSON.stringify(sources),
        projectId: projectId ?? undefined,
      });
      const result: DraftResult = {
        ...data,
        worksCitedCount: data.worksCitedCount ?? data.draft.worksCited.length,
      };
      setProjectId(result.projectId);
      const entry = toVersionEntry(result);
      setVersions((prev) => [...prev.filter((v) => v.id !== entry.id), entry]);
      setSelectedVersionId(entry.id);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : t("draftFailed"));
    } finally {
      inflight.current.draft = false;
      setDraftBusy(false);
    }
  }, [structure, sources, topic, instructionText, wordTarget, minimumFootnotes, minimumSources, projectId, draftBusy, t]);

  async function runOneShot() {
    if (!validateContext() || outlineBusy || sourcesBusy || draftBusy || inflight.current.oneShot) return;
    inflight.current.oneShot = true;
    setGlobalError(null);
    try {
      // Stage 1: outline
      setOutlineBusy(true);
      const outline = await postJSON<{ projectId: string; structure: EssayStructure }>("/api/structure", {
        topic: topic.trim(),
        instructionText: instructionText.trim(),
        extraInstructions: "",
        wordTarget,
        projectId: projectId ?? undefined,
      });
      const pid = outline.projectId;
      setProjectId(pid);
      setStructure(outline.structure);
      setStructureEdited(false);
      setOutlineApproved(true);
      setOutlineBusy(false);

      // Stage 2: sources (synchronous, same everywhere)
      setSourcesBusy(true);
      const found = await postJSON<{
        sources: SourceItem[];
        liveSearchUsed: boolean;
        liveHits: number;
      }>("/api/sources", {
        topic: topic.trim(),
        structureJson: JSON.stringify(outline.structure),
        projectId: pid,
        needed: 18,
      });
      setSources(found.sources);
      setLiveSearchUsed(found.liveSearchUsed);
      setLiveHits(found.liveHits);
      setSourcesApproved(true);
      setSourcesBusy(false);

      // Stage 3: draft
      setDraftBusy(true);
      const drafted = await postJSON<DraftResult>("/api/draft", {
        minimumFootnotes,
        minimumSources,
        topic: topic.trim(),
        instructionText: instructionText.trim(),
        extraInstructions: "",
        wordTarget,
        structureJson: JSON.stringify(outline.structure),
        sourcesJson: JSON.stringify(found.sources),
        projectId: pid,
      });
      const result: DraftResult = {
        ...drafted,
        worksCitedCount: drafted.worksCitedCount ?? drafted.draft.worksCited.length,
      };
      const entry = toVersionEntry(result);
      setVersions((prev) => [...prev.filter((v) => v.id !== entry.id), entry]);
      setSelectedVersionId(entry.id);
      setDraftBusy(false);
      inflight.current.oneShot = false;
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : t("oneShotFailed"));
      setOutlineBusy(false);
      setSourcesBusy(false);
      setDraftBusy(false);
      inflight.current.oneShot = false;
    }
  }

  function handleRefined(result: DraftResult) {
    const entry = toVersionEntry(result);
    setProjectId(result.projectId);
    setVersions((prev) => [...prev.filter((v) => v.id !== entry.id), entry]);
    setSelectedVersionId(entry.id);
    // Merge freshly fetched follow-up sources into the sidebar list.
    if (result.newSources && result.newSources.length > 0) {
      setSources((prev) => {
        const seen = new Set(prev.map((s) => (s.url || "").trim().toLowerCase()));
        const fresh = result.newSources!.filter((s) => {
          const key = (s.url || "").trim().toLowerCase();
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
      // Extended list needs a fresh approval before any re-draft uses it.
      setSourcesApproved(false);
    }
  }

  function openHistoryProject(id: string) {
    const item = history.find((h) => h.id === id);
    const latest = item?.versions?.[0];
    if (!item || !latest) return;
    setProjectId(item.id);
    setGlobalError(null);
    if (item.topic) setTopic(item.topic);
    setInstructionText(item.instruction || "");
    if (item.wordTarget) setWordTarget(Math.min(3000, Math.max(400, item.wordTarget)));
    if (projectId !== item.id) {
      setStructure(null);
      setStructureEdited(false);
      setOutlineApproved(false);
      setSources([]);
      setSourcesApproved(false);
      setLiveSearchUsed(false);
      setLiveHits(0);
    }
    setVersions((prev) => {
      if (projectId !== item.id) prev = [];
      if (prev.some((v) => v.id === latest.id)) return prev;
      return [
        ...prev,
        {
          id: latest.id,
          version: latest.version,
          title: latest.title || item.title,
          wordCount: latest.wordCount,
          footnoteCount: latest.footnoteCount,
          worksCitedCount: 0,
          summary: latest.summary,
          downloadUrl: `/api/download/${latest.id}`,
          draft: null,
          issues: [],
        },
      ];
    });
    setSelectedVersionId(latest.id);
  }

  return (
    <div className="essay-studio min-h-screen bg-stone-100 font-sans text-stone-900 transition-colors duration-150 dark:bg-stone-950 dark:text-stone-100">
      {/* Sticky top bar */}
      <header className="sticky top-0 z-20 border-b border-stone-200 bg-stone-50 transition-colors duration-150 dark:border-stone-800 dark:bg-stone-900/90 dark:backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-800 font-serif text-lg font-bold text-white shadow-sm dark:bg-emerald-700"
            >
              E
            </span>
            <div className="leading-tight">
              <p className="text-sm font-bold tracking-tight">{t("appTitle")}</p>
              <p className="max-w-48 sm:max-w-64 md:max-w-md truncate text-xs text-stone-600 dark:text-stone-400" title={projectTitle}>
                {projectTitle}
              </p>
            </div>
          </div>

          <div className="ms-auto flex flex-wrap items-center gap-2">
            <LanguageSwitch />
            <ThemeSwitch />

            <label htmlFor="history-select" className="sr-only">
              {t("openRecentSr")}
            </label>
            <select
              id="history-select"
              value=""
              onChange={(e) => {
                if (e.target.value) openHistoryProject(e.target.value);
              }}
              aria-describedby={historyNote ? "history-note" : undefined}
              className="max-w-36 sm:max-w-52 truncate rounded-lg border border-stone-300 bg-white px-2 py-2 text-xs font-semibold text-stone-700 shadow-sm transition focus:border-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-700/20 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200"
            >
              <option value="">{t("openRecent")}</option>
              {history.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.title || h.topic || t("untitledEssay")} ({h._count.versions}v)
                </option>
              ))}
            </select>
            {selectedEntry ? (
              <a
                href={selectedEntry.downloadUrl}
                download
                className="inline-flex items-center justify-center rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 active:scale-[0.98] dark:bg-emerald-700 dark:hover:bg-emerald-600"
              >
                {t("download")}
              </a>
            ) : (
              <span
                aria-disabled="true"
                title={t("downloadTooltipDisabled")}
                className="inline-flex cursor-not-allowed items-center justify-center rounded-lg bg-stone-300 px-4 py-2 text-sm font-semibold text-stone-500 dark:bg-stone-800 dark:text-stone-500"
              >
                {t("download")}
              </span>
            )}
          </div>
        </div>
        {historyNote ? (
          <p id="history-note" className="border-t border-stone-200 px-4 py-1 text-xs text-stone-600 dark:border-stone-800 dark:text-stone-400">
            {historyNote}
          </p>
        ) : null}
      </header>

      {globalError ? (
        <div className="px-4 pt-4" role="alert">
          <div className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 dark:border-red-900/40 dark:bg-red-950/30">
            <div>
              <p className="text-sm font-bold text-red-900 dark:text-red-300">{t("somethingWentWrong")}</p>
              <p className="mt-0.5 text-sm leading-6 text-red-800 dark:text-red-200">{globalError}</p>
            </div>
            <button
              type="button"
              onClick={() => setGlobalError(null)}
              aria-label={t("dismissError")}
              className="shrink-0 rounded-md px-2 py-1 text-sm font-bold text-red-900 transition hover:bg-red-100 dark:text-red-300 dark:hover:bg-red-900/40 active:scale-[0.98]"
            >
              ✕
            </button>
          </div>
        </div>
      ) : null}

      {/* 3-pane studio */}
      <main className="grid grid-cols-1 items-start gap-4 p-4 xl:grid-cols-[340px_minmax(0,1fr)_460px]">
        <section
          aria-label={t("stepContext")}
          className="min-w-0 rounded-xl border border-stone-200 bg-stone-50 p-4 shadow-sm transition-colors duration-150 dark:border-stone-800 dark:bg-stone-900/60"
        >
          <InputPanel
            topic={topic}
            onTopicChange={(v) => {
              setTopic(v);
              if (v.trim()) setTopicError(null);
            }}
            wordTarget={wordTarget}
            onWordTargetChange={setWordTarget}
            minimumFootnotes={minimumFootnotes}
            minimumSources={minimumSources}
            onMinimumFootnotesChange={(value) => updateCitationMinimums(value, minimumSources)}
            onMinimumSourcesChange={(value) => updateCitationMinimums(minimumFootnotes, value)}
            instructionText={instructionText}
            onInstructionChange={(v) => {
              setInstructionText(v);
              if (v.trim()) setInstructionError(null);
            }}
            mode={mode}
            onModeChange={setMode}
            onParsedText={(appended) =>
              setInstructionText((prev) => (prev ? `${prev}\n\n${appended}` : appended))
            }
            onGenerateOutline={generateOutline}
            onGatherSources={gatherSources}
            onDraftEssay={draftEssay}
            onOneShot={runOneShot}
            outlineBusy={outlineBusy}
            sourcesBusy={sourcesBusy}
            draftBusy={draftBusy}
            hasOutline={Boolean(structure)}
            hasSources={sources.length > 0}
            outlineApproved={outlineApproved}
            sourcesApproved={sourcesApproved}
            topicError={topicError}
            instructionError={instructionError}
          />
        </section>

        <PipelinePanel
          structure={structure}
          outlineApproved={outlineApproved}
          outlineBusy={outlineBusy}
          structureEdited={structureEdited}
          onApproveOutline={() => setOutlineApproved(true)}
          onReopenOutline={() => setOutlineApproved(false)}
          onEditThesis={(v) => {
            setStructure((s) => (s ? { ...s, thesis: v } : s));
            setStructureEdited(true);
          }}
          onEditSectionHeading={(si, v) => {
            setStructure((s) =>
              s ? { ...s, sections: s.sections.map((sec, i) => (i === si ? { ...sec, heading: v } : sec)) } : s,
            );
            setStructureEdited(true);
          }}
          onEditPoint={(si, pi, v) => {
            setStructure((s) =>
              s
                ? {
                    ...s,
                    sections: s.sections.map((sec, i) =>
                      i === si
                        ? { ...sec, paragraphs: sec.paragraphs.map((p, j) => (j === pi ? { ...p, point: v } : p)) }
                        : sec,
                    ),
                  }
                : s,
            );
            setStructureEdited(true);
          }}
          onEditPointMeta={(si, pi, field, v) => {
            setStructure((s) =>
              s
                ? {
                    ...s,
                    sections: s.sections.map((sec, i) =>
                      i === si
                        ? {
                            ...sec,
                            paragraphs: sec.paragraphs.map((p, j) =>
                              j === pi ? { ...p, [field]: v } : p
                            ),
                          }
                        : sec,
                    ),
                  }
                : s,
            );
            setStructureEdited(true);
          }}
          sources={sources}
          liveSearchUsed={liveSearchUsed}
          liveHits={liveHits}
          sourcesBusy={sourcesBusy}
          sourcesElapsed={useElapsed(sourcesBusy)}
          sourcesApproved={sourcesApproved}
          onApproveSources={() => setSourcesApproved(true)}
          onReopenSources={() => setSourcesApproved(false)}
          issues={latestIssues}
          coverage={coverage}
          hasDraft={versions.length > 0}
        />

        <PreviewPanel
          minimumFootnotes={minimumFootnotes}
          minimumSources={minimumSources}
          entry={selectedEntry}
          versions={versions}
          onSelectVersion={setSelectedVersionId}
          wordTarget={wordTarget}
          projectId={projectId}
          draftBusy={draftBusy}
          onRefined={handleRefined}
        />
      </main>

      <footer className="border-t border-stone-200 px-4 py-4 text-center text-xs leading-5 text-stone-600 transition-colors duration-150 dark:border-stone-800 dark:text-stone-400">
        {t("footerText")}
      </footer>
    </div>
  );
}
