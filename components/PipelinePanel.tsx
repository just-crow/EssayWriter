"use client";

import type { EssayStructure, JobSnapshot, SourceItem, ValidationIssue } from "./studio-types";

interface CoverageItem {
  item: string;
  met: boolean;
  location: string;
}

interface PipelinePanelProps {
  structure: EssayStructure | null;
  outlineApproved: boolean;
  outlineBusy: boolean;
  structureEdited: boolean;
  onApproveOutline: () => void;
  onReopenOutline: () => void;
  onEditThesis: (v: string) => void;
  onEditSectionHeading: (si: number, v: string) => void;
  onEditPoint: (si: number, pi: number, v: string) => void;
  sources: SourceItem[];
  liveSearchUsed: boolean | null;
  liveHits: number;
  sourcesBusy: boolean;
  sourcesJob: JobSnapshot | null;
  sourcesApproved: boolean;
  onApproveSources: () => void;
  onReopenSources: () => void;
  issues: ValidationIssue[];
  coverage: CoverageItem[];
  hasDraft: boolean;
}

const cardClass = "rounded-xl border border-stone-200 bg-white p-4 shadow-sm";
const approveBtn =
  "inline-flex items-center justify-center rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 active:scale-[0.98]";
const reopenBtn =
  "inline-flex items-center justify-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 shadow-sm transition hover:border-emerald-700 hover:text-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 active:scale-[0.98]";

function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-hidden="true" className="space-y-2">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded bg-stone-200"
          style={{ width: `${92 - i * 14}%` }}
        />
      ))}
    </div>
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 px-4 py-6 text-center">
      <p className="text-sm font-semibold text-stone-800">{title}</p>
      <p className="mt-1 text-xs leading-5 text-stone-600">{hint}</p>
    </div>
  );
}

export default function PipelinePanel(props: PipelinePanelProps) {
  const {
    structure,
    outlineApproved,
    outlineBusy,
    structureEdited,
    onApproveOutline,
    onReopenOutline,
    onEditThesis,
    onEditSectionHeading,
    onEditPoint,
    sources,
    liveSearchUsed,
    liveHits,
    sourcesBusy,
    sourcesJob,
    sourcesApproved,
    onApproveSources,
    onReopenSources,
    issues,
    coverage,
    hasDraft,
  } = props;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Outline */}
      <section aria-labelledby="outline-heading" className={cardClass}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="outline-heading" className="text-base font-bold text-stone-900">
            Outline
          </h2>
          {structure && !outlineBusy ? (
            outlineApproved ? (
              <span className="rounded-full bg-emerald-800 px-2.5 py-0.5 text-xs font-bold text-white">
                Approved
              </span>
            ) : (
              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-900">
                Needs approval
              </span>
            )
          ) : null}
        </div>

        {outlineBusy ? (
          <div aria-live="polite">
            <Skeleton lines={5} />
            <p className="mt-2 text-xs text-stone-600">Writing your outline… the model usually answers within a minute.</p>
          </div>
        ) : structure ? (
          <div className="flex flex-col gap-3">
            <div>
              <p className="mb-1 text-xs font-bold uppercase tracking-wide text-stone-500">Thesis</p>
              {outlineApproved ? (
                <p className="text-sm leading-6 text-stone-900">{structure.thesis}</p>
              ) : (
                <textarea
                  aria-label="Edit thesis"
                  value={structure.thesis}
                  onChange={(e) => onEditThesis(e.target.value)}
                  rows={3}
                  className="w-full resize-y rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm leading-6 text-stone-900 shadow-sm transition focus:border-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-700/20"
                />
              )}
            </div>

            <ol className="flex flex-col gap-3">
              {structure.sections.map((sec, si) => (
                <li key={si} className="rounded-lg bg-stone-50 p-3">
                  {outlineApproved ? (
                    <p className="text-sm font-bold text-stone-900">
                      {si + 1}. {sec.heading}
                    </p>
                  ) : (
                    <input
                      aria-label={`Edit heading for section ${si + 1}`}
                      value={sec.heading}
                      onChange={(e) => onEditSectionHeading(si, e.target.value)}
                      className="mb-2 w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-sm font-bold text-stone-900 shadow-sm focus:border-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-700/20"
                    />
                  )}
                  <ul className="mt-1 flex list-disc flex-col gap-1.5 pl-5">
                    {sec.paragraphs.map((p, pi) => (
                      <li key={pi} className="text-sm leading-6 text-stone-800">
                        {outlineApproved ? (
                          <>
                            {p.point}
                            {p.criterion || p.strand ? (
                              <span className="text-stone-500">
                                {" "}
                                — {[p.criterion, p.strand].filter(Boolean).join(" · ")}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <input
                            aria-label={`Edit point ${pi + 1} in section ${si + 1}`}
                            value={p.point}
                            onChange={(e) => onEditPoint(si, pi, e.target.value)}
                            className="w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-sm text-stone-900 shadow-sm focus:border-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-700/20"
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>

            {structure.checklist.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-bold uppercase tracking-wide text-stone-500">Checklist</p>
                <ul className="flex flex-col gap-1">
                  {structure.checklist.map((c, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm leading-6 text-stone-800">
                      <span aria-hidden="true" className="mt-0.5 text-emerald-800">☐</span>
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2 pt-1">
              {outlineApproved ? (
                <button type="button" onClick={onReopenOutline} className={reopenBtn}>
                  Edit outline
                </button>
              ) : (
                <button type="button" onClick={onApproveOutline} className={approveBtn}>
                  Approve outline
                </button>
              )}
              {structureEdited && !outlineApproved ? (
                <p className="w-full text-xs text-stone-600">Edited — approval uses your revised wording.</p>
              ) : null}
            </div>
          </div>
        ) : (
          <Empty
            title="No outline yet"
            hint="Fill in the context on the left, then generate an outline to review here."
          />
        )}
      </section>

      {/* Sources */}
      <section aria-labelledby="sources-heading" className={cardClass}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="sources-heading" className="text-base font-bold text-stone-900">
            Sources
          </h2>
          <div className="flex items-center gap-2">
            {liveSearchUsed !== null ? (
              liveSearchUsed ? (
                <span
                  title={`${liveHits} live result${liveHits === 1 ? "" : "s"} informed this list`}
                  className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-900"
                >
                  Live search · {liveHits}
                </span>
              ) : (
                <span
                  title="No live results; the list draws on model knowledge. Verify URLs before submitting."
                  className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-900"
                >
                  Model knowledge
                </span>
              )
            ) : null}
            {sources.length > 0 && !sourcesBusy ? (
              sourcesApproved ? (
                <span className="rounded-full bg-emerald-800 px-2.5 py-0.5 text-xs font-bold text-white">
                  Approved
                </span>
              ) : (
                <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-900">
                  Needs approval
                </span>
              )
            ) : null}
          </div>
        </div>

        {sourcesBusy ? (
          <div aria-live="polite">
            <Skeleton lines={4} />
            <p className="mt-2 text-xs text-stone-600">
              {sourcesJob && (sourcesJob.stage || sourcesJob.attempt > 0) ? (
                <>
                  {sourcesJob.stage || "Working…"}
                  {sourcesJob.attempt > 0 ? (
                    <span className="text-stone-500">
                      {" "}· attempt {sourcesJob.attempt}/{sourcesJob.maxAttempts}
                    </span>
                  ) : null}
                  <span className="text-stone-500"> · {sourcesJob.elapsedSec}s elapsed</span>
                </>
              ) : (
                "Starting source search…"
              )}
            </p>
          </div>
        ) : sources.length > 0 ? (
          <div className="flex flex-col gap-3">
            <ol className="flex flex-col gap-2.5">
              {sources.map((s, i) => (
                <li key={s.id || i} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                  <p className="text-sm font-bold leading-6 text-stone-900">
                    {s.author ? `${s.author}. ` : ""}“{s.title || "Untitled"}”
                    {s.year ? ` (${s.year})` : ""}
                  </p>
                  {s.publisher || s.container ? (
                    <p className="text-xs leading-5 text-stone-600">
                      {[s.container, s.publisher].filter(Boolean).join(" · ")}
                      {s.kind ? ` · ${s.kind}` : ""}
                    </p>
                  ) : null}
                  {s.supports ? (
                    <p className="mt-1 text-xs leading-5 text-stone-700">
                      <span className="font-semibold text-emerald-900">Supports:</span> {s.supports}
                    </p>
                  ) : null}
                  {s.url ? (
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-block max-w-full truncate text-xs font-medium text-emerald-800 underline decoration-emerald-800/40 underline-offset-2 hover:text-emerald-900"
                    >
                      {s.url}
                    </a>
                  ) : (
                    <p className="mt-1 text-xs font-medium text-red-800">No link provided.</p>
                  )}
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-2">
              {sourcesApproved ? (
                <button type="button" onClick={onReopenSources} className={reopenBtn}>
                  Edit sources
                </button>
              ) : (
                <button type="button" onClick={onApproveSources} className={approveBtn}>
                  Approve sources
                </button>
              )}
            </div>
          </div>
        ) : (
          <Empty
            title="No sources yet"
            hint="Approve the outline first, then gather a reading list for this essay."
          />
        )}
      </section>

      {/* Validation */}
      <section aria-labelledby="validation-heading" className={cardClass}>
        <h2 id="validation-heading" className="mb-3 text-base font-bold text-stone-900">
          Validation
        </h2>
        {!hasDraft ? (
          <Empty title="Nothing to check" hint="Style and link checks appear here after the first draft." />
        ) : issues.length === 0 ? (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-900">
            No issues found. The draft passed every check.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {issues.map((issue, i) => (
              <li key={i} className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2">
                <span className="mt-0.5 shrink-0 rounded bg-amber-200/70 px-1.5 py-0.5 font-mono text-[11px] font-bold text-amber-900">
                  {issue.code}
                </span>
                <span className="text-sm leading-6 text-stone-800">{issue.detail}</span>
              </li>
            ))}
          </ul>
        )}

        {coverage.length > 0 ? (
          <div className="mt-4">
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-stone-500">Coverage</p>
            <ul className="flex flex-col gap-1.5">
              {coverage.map((c, i) => (
                <li key={i} className="flex items-start gap-2 text-sm leading-6 text-stone-800">
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                      c.met ? "bg-emerald-800 text-white" : "bg-stone-300 text-stone-600"
                    }`}
                  >
                    {c.met ? "✓" : "·"}
                  </span>
                  <span>
                    {c.item}
                    {c.location ? <span className="text-stone-500"> — {c.location}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </div>
  );
}
