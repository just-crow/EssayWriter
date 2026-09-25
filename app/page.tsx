"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import InputPanel from "@/components/InputPanel";
import PipelinePanel from "@/components/PipelinePanel";
import PreviewPanel from "@/components/PreviewPanel";
import {
  toVersionEntry,
  type DraftResult,
  type EssayStructure,
  type HistoryProject,
  type JobSnapshot,
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

/** Poll a background job until done/error. Resolves with the final snapshot. */
async function pollJob(jobId: string, onTick?: (j: JobSnapshot) => void): Promise<JobSnapshot> {
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`/api/jobs/${jobId}`);
    const data = (await res.json().catch(() => ({}))) as { job?: JobSnapshot; error?: string };
    if (!res.ok) throw new Error(data.error || "Job lookup failed.");
    const job = data.job;
    if (!job) throw new Error("Job vanished.");
    onTick?.(job);
    if (job.status === "done") return job;
    if (job.status === "error") throw new Error(job.error || "Sources job failed.");
  }
  throw new Error("Sources are taking too long. Try again.");
}

export default function StudioPage() {
  // Context state
  const [topic, setTopic] = useState("");
  const [wordTarget, setWordTarget] = useState(1200);
  const [instructionText, setInstructionText] = useState("");
  const [mode, setMode] = useState<"staged" | "one-shot">("staged");

  // Project state
  const [projectId, setProjectId] = useState<string | null>(null);
  const [structure, setStructure] = useState<EssayStructure | null>(null);
  const [structureEdited, setStructureEdited] = useState(false);
  const [outlineApproved, setOutlineApproved] = useState(false);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [sourcesJob, setSourcesJob] = useState<JobSnapshot | null>(null);
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

  // History via /api/projects
  const [history, setHistory] = useState<HistoryProject[]>([]);
  const [historyNote, setHistoryNote] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/projects");
        const data = (await res.json().catch(() => ({}))) as { projects?: HistoryProject[] };
        if (!res.ok) throw new Error("History unavailable.");
        setHistory(data.projects ?? []);
      } catch {
        setHistoryNote("Recent essays are unavailable right now.");
      }
    })();
  }, []);

  const selectedEntry = versions.find((v) => v.id === selectedVersionId) ?? versions[versions.length - 1] ?? null;
  const latestIssues: ValidationIssue[] = selectedEntry?.issues ?? [];
  const coverage = selectedEntry?.draft?.coverage ?? [];
  const projectTitle =
    selectedEntry?.draft?.title || selectedEntry?.title || topic.trim() || "Untitled essay";

  function validateContext(): boolean {
    if (!topic.trim()) {
      setTopicError("Add an essay topic first.");
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
      setGlobalError(err instanceof Error ? err.message : "Outline failed.");
    } finally {
      inflight.current.outline = false;
      setOutlineBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, instructionText, wordTarget, projectId, outlineBusy]);

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
    setSourcesJob(null);
    try {
      const started = await postJSON<
        { jobId: string } & {
          sources?: SourceItem[];
          liveSearchUsed?: boolean;
          liveHits?: number;
        }
      >("/api/sources", {
        topic: topic.trim(),
        structureJson: JSON.stringify(structure),
        projectId: projectId ?? undefined,
        needed: 12,
      });
      if (started.sources) {
        applySources({
          sources: started.sources,
          liveSearchUsed: started.liveSearchUsed ?? true,
          liveHits: started.liveHits ?? 0,
        });
      } else {
        const job = await pollJob(started.jobId, setSourcesJob);
        applySources(
          job.result as unknown as {
            sources: SourceItem[];
            liveSearchUsed: boolean;
            liveHits: number;
          }
        );
      }
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "Sources failed.");
    } finally {
      inflight.current.sources = false;
      setSourcesBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure, topic, projectId, sourcesBusy]);

  const draftEssay = useCallback(async () => {
    if (!structure || sources.length === 0 || draftBusy || inflight.current.draft) return;
    inflight.current.draft = true;
    setGlobalError(null);
    setDraftBusy(true);
    try {
      const data = await postJSON<DraftResult & { error?: string }>("/api/draft", {
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
      setGlobalError(err instanceof Error ? err.message : "Draft failed.");
    } finally {
      inflight.current.draft = false;
      setDraftBusy(false);
    }
  }, [structure, sources, topic, instructionText, wordTarget, projectId, draftBusy]);

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

      // Stage 2: sources (job+poll locally, synchronous on serverless)
      setSourcesBusy(true);
      setSourcesJob(null);
      const started = await postJSON<
        { jobId: string } & {
          sources?: SourceItem[];
          liveSearchUsed?: boolean;
          liveHits?: number;
        }
      >("/api/sources", {
        topic: topic.trim(),
        structureJson: JSON.stringify(outline.structure),
        projectId: pid,
        needed: 12,
      });
      const found: { sources: SourceItem[]; liveSearchUsed: boolean; liveHits: number } =
        started.sources
          ? {
              sources: started.sources,
              liveSearchUsed: started.liveSearchUsed ?? true,
              liveHits: started.liveHits ?? 0,
            }
          : await (async () => {
              const job = await pollJob(started.jobId as string, setSourcesJob);
              return job.result as unknown as {
                sources: SourceItem[];
                liveSearchUsed: boolean;
                liveHits: number;
              };
            })();
      setSources(found.sources);
      setLiveSearchUsed(found.liveSearchUsed);
      setLiveHits(found.liveHits);
      setSourcesApproved(true);
      setSourcesBusy(false);

      // Stage 3: draft
      setDraftBusy(true);
      const drafted = await postJSON<DraftResult>("/api/draft", {
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
      setGlobalError(err instanceof Error ? err.message : "One-shot run failed.");
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
  }

  function openHistoryProject(id: string) {
    const item = history.find((h) => h.id === id);
    const latest = item?.versions?.[0];
    if (!item || !latest) return;
    setProjectId(item.id);
    setGlobalError(null);
    if (item.topic) setTopic(item.topic);
    if (item.wordTarget) setWordTarget(Math.min(3000, Math.max(400, item.wordTarget)));
    setVersions((prev) => {
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
    <div className="essay-studio min-h-screen bg-stone-100 font-sans text-stone-900">
      {/* Sticky top bar */}
      <header className="sticky top-0 z-20 border-b border-stone-200 bg-stone-50">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-800 font-serif text-lg font-bold text-white"
            >
              E
            </span>
            <div className="leading-tight">
              <p className="text-sm font-bold tracking-tight">EssayWriter Studio</p>
              <p className="max-w-64 truncate text-xs text-stone-600 md:max-w-md" title={projectTitle}>
                {projectTitle}
              </p>
            </div>
          </div>

          <div className="ms-auto flex flex-wrap items-center gap-2">
            <label htmlFor="history-select" className="sr-only">
              Open recent essay
            </label>
            <select
              id="history-select"
              value=""
              onChange={(e) => {
                if (e.target.value) openHistoryProject(e.target.value);
              }}
              aria-describedby={historyNote ? "history-note" : undefined}
              className="max-w-52 truncate rounded-lg border border-stone-300 bg-white px-2 py-2 text-xs font-semibold text-stone-700 shadow-sm focus:border-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-700/20"
            >
              <option value="">Open recent…</option>
              {history.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.title || h.topic || "Untitled"} ({h._count.versions}v)
                </option>
              ))}
            </select>
            {selectedEntry ? (
              <a
                href={selectedEntry.downloadUrl}
                download
                className="inline-flex items-center justify-center rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 active:scale-[0.98]"
              >
                Download
              </a>
            ) : (
              <span
                aria-disabled="true"
                title="Download appears after the first draft"
                className="inline-flex cursor-not-allowed items-center justify-center rounded-lg bg-stone-300 px-4 py-2 text-sm font-semibold text-stone-500"
              >
                Download
              </span>
            )}
          </div>
        </div>
        {historyNote ? (
          <p id="history-note" className="border-t border-stone-200 px-4 py-1 text-xs text-stone-600">
            {historyNote}
          </p>
        ) : null}
      </header>

      {globalError ? (
        <div className="px-4 pt-4" role="alert">
          <div className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
            <div>
              <p className="text-sm font-bold text-red-900">Something went wrong</p>
              <p className="mt-0.5 text-sm leading-6 text-red-800">{globalError}</p>
            </div>
            <button
              type="button"
              onClick={() => setGlobalError(null)}
              aria-label="Dismiss error"
              className="shrink-0 rounded-md px-2 py-1 text-sm font-bold text-red-900 transition hover:bg-red-100 active:scale-[0.98]"
            >
              ✕
            </button>
          </div>
        </div>
      ) : null}

      {/* 3-pane studio */}
      <main className="grid grid-cols-1 items-start gap-4 p-4 xl:grid-cols-[340px_minmax(0,1fr)_460px]">
        <section
          aria-label="Context input"
          className="min-w-0 rounded-xl border border-stone-200 bg-stone-50 p-4 shadow-sm"
        >
          <InputPanel
            topic={topic}
            onTopicChange={(v) => {
              setTopic(v);
              if (v.trim()) setTopicError(null);
            }}
            wordTarget={wordTarget}
            onWordTargetChange={setWordTarget}
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
          sources={sources}
          liveSearchUsed={liveSearchUsed}
          liveHits={liveHits}
          sourcesBusy={sourcesBusy}
          sourcesJob={sourcesJob}
          sourcesApproved={sourcesApproved}
          onApproveSources={() => setSourcesApproved(true)}
          onReopenSources={() => setSourcesApproved(false)}
          issues={latestIssues}
          coverage={coverage}
          hasDraft={versions.length > 0}
        />

        <PreviewPanel
          entry={selectedEntry}
          versions={versions}
          onSelectVersion={setSelectedVersionId}
          wordTarget={wordTarget}
          projectId={projectId}
          draftBusy={draftBusy}
          onRefined={handleRefined}
        />
      </main>

      <footer className="border-t border-stone-200 px-4 py-4 text-center text-xs leading-5 text-stone-600">
        Outline, sources, and draft stay in sync — approve each stage to unlock the next.
      </footer>
    </div>
  );
}
