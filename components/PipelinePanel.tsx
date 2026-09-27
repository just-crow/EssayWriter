"use client";

import type { EssayStructure, SourceItem, ValidationIssue } from "./studio-types";
import { buildCriteriaMap, criteriaForSource } from "./criteriaMap";
import { useLanguage } from "./LanguageContext";

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
  onEditPointMeta: (si: number, pi: number, field: "criterion" | "strand", v: string) => void;
  sources: SourceItem[];
  liveSearchUsed: boolean | null;
  liveHits: number;
  sourcesBusy: boolean;
  sourcesElapsed: number;
  sourcesApproved: boolean;
  onApproveSources: () => void;
  onReopenSources: () => void;
  issues: ValidationIssue[];
  coverage: CoverageItem[];
  hasDraft: boolean;
}

const cardClass = "rounded-xl border border-stone-200 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900/80 transition-colors duration-150";
const approveBtn =
  "inline-flex items-center justify-center rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 active:scale-[0.98] dark:bg-emerald-700 dark:hover:bg-emerald-600";
const reopenBtn =
  "inline-flex items-center justify-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 shadow-sm transition hover:border-emerald-700 hover:text-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 active:scale-[0.98] dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300 dark:hover:border-emerald-500 dark:hover:text-emerald-300";

function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-hidden="true" className="space-y-2">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded bg-stone-200 dark:bg-stone-700"
          style={{ width: `${92 - i * 14}%` }}
        />
      ))}
    </div>
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 px-4 py-6 text-center dark:border-stone-800 dark:bg-stone-900/40">
      <p className="text-sm font-semibold text-stone-800 dark:text-stone-200">{title}</p>
      <p className="mt-1 text-xs leading-5 text-stone-600 dark:text-stone-400">{hint}</p>
    </div>
  );
}

export default function PipelinePanel(props: PipelinePanelProps) {
  const { t } = useLanguage();
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
    onEditPointMeta,
    sources,
    liveSearchUsed,
    liveHits,
    sourcesBusy,
    sourcesElapsed,
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
          <h2 id="outline-heading" className="text-base font-bold text-stone-900 dark:text-stone-100">
            {t("outlineHeading")}
          </h2>
          {structure && !outlineBusy ? (
            outlineApproved ? (
              <span className="rounded-full bg-emerald-800 px-2.5 py-0.5 text-xs font-bold text-white dark:bg-emerald-700">
                {t("approvedBadge")}
              </span>
            ) : (
              <span className="rounded-full border border-amber-300/40 bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/80 dark:text-amber-300">
                {t("needsApprovalBadge")}
              </span>
            )
          ) : null}
        </div>

        {outlineBusy ? (
          <div aria-live="polite">
            <Skeleton lines={5} />
            <p className="mt-2 text-xs text-stone-600 dark:text-stone-400">{t("outlineModelWaiting")}</p>
          </div>
        ) : structure ? (
          <div className="flex flex-col gap-3">
            <div>
              <p className="mb-1 text-xs font-bold uppercase tracking-wide text-stone-500 dark:text-stone-400">{t("thesisLabel")}</p>
              {outlineApproved ? (
                <p className="text-sm leading-6 text-stone-900 dark:text-stone-100">{structure.thesis}</p>
              ) : (
                <textarea
                  aria-label={t("editThesisAria")}
                  value={structure.thesis}
                  onChange={(e) => onEditThesis(e.target.value)}
                  rows={3}
                  className="w-full resize-y rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm leading-6 text-stone-900 shadow-sm transition focus:border-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-700/20 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100 dark:focus:border-emerald-500"
                />
              )}
            </div>

            <ol className="flex flex-col gap-3">
              {structure.sections.map((sec, si) => (
                <li key={si} className="rounded-lg bg-stone-50 p-3 dark:bg-stone-800/50">
                  {outlineApproved ? (
                    <p className="text-sm font-bold text-stone-900 dark:text-stone-100">
                      {si + 1}. {sec.heading}
                    </p>
                  ) : (
                    <input
                      aria-label={t("editSectionHeadingAria", { num: si + 1 })}
                      value={sec.heading}
                      onChange={(e) => onEditSectionHeading(si, e.target.value)}
                      className="mb-2 w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-sm font-bold text-stone-900 shadow-sm focus:border-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-700/20 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100 dark:focus:border-emerald-500"
                    />
                  )}
                  <ul className="mt-1 flex list-disc flex-col gap-1.5 pl-5">
                    {sec.paragraphs.map((p, pi) => (
                      <li key={pi} className="text-sm leading-6 text-stone-800 dark:text-stone-200">
                        {outlineApproved ? (
                          <>
                            {p.point}
                            {p.criterion || p.strand ? (
                              <span className="text-stone-500 dark:text-stone-400">
                                {" "}
                                — {[p.criterion, p.strand].filter(Boolean).join(" · ")}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <div className="flex flex-col gap-1.5">
                            <input
                              aria-label={t("editPointAria", { pNum: pi + 1, sNum: si + 1 })}
                              value={p.point}
                              onChange={(e) => onEditPoint(si, pi, e.target.value)}
                              className="w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-sm text-stone-900 shadow-sm transition focus:border-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-700/20 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100 dark:focus:border-emerald-500"
                            />
                            <div className="flex flex-col gap-1.5 sm:flex-row">
                              <label className="flex flex-1 items-center gap-1.5">
                                <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
                                  {t("criterionLabel")}
                                </span>
                                <input
                                  aria-label={t("editCriterionAria", { pNum: pi + 1, sNum: si + 1 })}
                                  value={p.criterion || ""}
                                  onChange={(e) => onEditPointMeta(si, pi, "criterion", e.target.value)}
                                  placeholder="e.g. Criterion B"
                                  className="w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-xs text-stone-900 shadow-sm transition focus:border-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-700/20 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100 dark:focus:border-emerald-500"
                                />
                              </label>
                              <label className="flex flex-1 items-center gap-1.5">
                                <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
                                  {t("strandLabel")}
                                </span>
                                <input
                                  aria-label={t("editStrandAria", { pNum: pi + 1, sNum: si + 1 })}
                                  value={p.strand || ""}
                                  onChange={(e) => onEditPointMeta(si, pi, "strand", e.target.value)}
                                  placeholder="e.g. strand ii"
                                  className="w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-xs text-stone-900 shadow-sm transition focus:border-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-700/20 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100 dark:focus:border-emerald-500"
                                />
                              </label>
                            </div>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>

            {structure.checklist.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-bold uppercase tracking-wide text-stone-500 dark:text-stone-400">{t("checklistLabel")}</p>
                <ul className="flex flex-col gap-1">
                  {structure.checklist.map((c, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm leading-6 text-stone-800 dark:text-stone-200">
                      <span aria-hidden="true" className="mt-0.5 text-emerald-800 dark:text-emerald-500">☐</span>
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2 pt-1">
              {outlineApproved ? (
                <button type="button" onClick={onReopenOutline} className={reopenBtn}>
                  {t("editOutline")}
                </button>
              ) : (
                <button type="button" onClick={onApproveOutline} className={approveBtn}>
                  {t("approveOutline")}
                </button>
              )}
              {structureEdited && !outlineApproved ? (
                <p className="w-full text-xs text-stone-600 dark:text-stone-400">{t("outlineEditedNote")}</p>
              ) : null}
            </div>
          </div>
        ) : (
          <Empty
            title={t("noOutlineTitle")}
            hint={t("noOutlineHint")}
          />
        )}
      </section>

      {/* Sources */}
      <section aria-labelledby="sources-heading" className={cardClass}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="sources-heading" className="text-base font-bold text-stone-900 dark:text-stone-100">
            {t("sourcesHeading")}
          </h2>
          <div className="flex items-center gap-2">
            {liveSearchUsed !== null ? (
              liveSearchUsed ? (
                <span
                  title={t("liveSearchTitle", { hits: liveHits, suffix: liveHits === 1 ? "" : "s" })}
                  className="rounded-full border border-emerald-300/40 bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-900 dark:border-emerald-800/50 dark:bg-emerald-950/80 dark:text-emerald-300"
                >
                  {t("liveSearchBadge", { hits: liveHits })}
                </span>
              ) : (
                <span
                  title={t("modelKnowledgeTitle")}
                  className="rounded-full border border-amber-300/40 bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/80 dark:text-amber-300"
                >
                  {t("modelKnowledgeBadge")}
                </span>
              )
            ) : null}
            {sources.length > 0 && !sourcesBusy ? (
              sourcesApproved ? (
                <span className="rounded-full bg-emerald-800 px-2.5 py-0.5 text-xs font-bold text-white dark:bg-emerald-700">
                  {t("approvedBadge")}
                </span>
              ) : (
                <span className="rounded-full border border-amber-300/40 bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/80 dark:text-amber-300">
                  {t("needsApprovalBadge")}
                </span>
              )
            ) : null}
          </div>
        </div>

        {sourcesBusy ? (
          <div aria-live="polite">
            <Skeleton lines={4} />
            <p className="mt-2 text-xs text-stone-600 dark:text-stone-400">
              {t("sourcesElapsed", { elapsed: sourcesElapsed })}
            </p>
          </div>
        ) : sources.length > 0 ? (
          <div className="flex flex-col gap-3">
            <ol className="flex flex-col gap-2.5">
              {sources.map((s, i) => (
                <li key={s.id || i} className="rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-800/40">
                  <p className="text-sm font-bold leading-6 text-stone-900 dark:text-stone-100">
                    {s.author ? `${s.author}. ` : ""}“{s.title || "Untitled"}”
                    {s.year ? ` (${s.year})` : ""}
                  </p>
                  {s.publisher || s.container ? (
                    <p className="text-xs leading-5 text-stone-600 dark:text-stone-400">
                      {[s.container, s.publisher].filter(Boolean).join(" · ")}
                      {s.kind ? ` · ${s.kind}` : ""}
                    </p>
                  ) : null}
                  {s.supports ? (
                    <p className="mt-1 text-xs leading-5 text-stone-700 dark:text-stone-300">
                      <span className="font-semibold text-emerald-900 dark:text-emerald-400">{t("supportsLabel")}</span> {s.supports}
                    </p>
                  ) : null}
                  {(() => {
                    const c = criteriaForSource(s, structure);
                    if (c.general || c.criteria.length === 0) return null;
                    return (
                      <p className="mt-1.5 flex flex-wrap gap-1.5">
                        {c.criteria.map((name) => (
                          <span
                            key={name}
                            title={c.strands.length > 0 ? c.strands.join(", ") : name}
                            className="rounded-full bg-emerald-800 px-2.5 py-0.5 text-[11px] font-bold text-white dark:bg-emerald-700"
                          >
                            {name}
                          </span>
                        ))}
                      </p>
                    );
                  })()}
                  {s.url ? (
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-block max-w-full truncate text-xs font-medium text-emerald-800 underline decoration-emerald-800/40 underline-offset-2 hover:text-emerald-900 dark:text-emerald-400 dark:decoration-emerald-400/40 dark:hover:text-emerald-300"
                    >
                      {s.url}
                    </a>
                  ) : (
                    <p className="mt-1 text-xs font-medium text-red-800 dark:text-red-400">{t("noLinkProvided")}</p>
                  )}
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-2">
              {sourcesApproved ? (
                <button type="button" onClick={onReopenSources} className={reopenBtn}>
                  {t("editSources")}
                </button>
              ) : (
                <button type="button" onClick={onApproveSources} className={approveBtn}>
                  {t("approveSources")}
                </button>
              )}
            </div>
          </div>
        ) : (
          <Empty
            title={t("noSourcesTitle")}
            hint={t("noSourcesHint")}
          />
        )}
      </section>

      {/* Criteria map */}
      {structure ? (
        <section aria-labelledby="criteria-heading" className={cardClass}>
          <h2 id="criteria-heading" className="mb-1 text-base font-bold text-stone-900 dark:text-stone-100">
            {t("criteriaMapHeading")}
          </h2>
          <p className="mb-3 text-xs leading-5 text-stone-600 dark:text-stone-400">
            {t("criteriaMapHelp")}
          </p>
          {(() => {
            const rows = buildCriteriaMap(structure, sources);
            if (rows.length === 0) {
              return (
                <p className="rounded-lg border border-dashed border-stone-300 bg-stone-50 px-4 py-4 text-center text-xs leading-5 text-stone-600 dark:border-stone-800 dark:bg-stone-900/40 dark:text-stone-400">
                  {t("noCriteriaYet")}
                </p>
              );
            }
            return (
              <ul className="flex flex-col gap-2.5">
                {rows.map((r) => (
                  <li key={r.name} className="rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-800/40">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-emerald-800 px-2.5 py-0.5 text-xs font-bold text-white dark:bg-emerald-700">
                        {r.name}
                      </span>
                      <span className="text-xs font-semibold text-stone-600 dark:text-stone-400">
                        {r.sourceIndexes.length === 1 ? t("sourceCountSingular") : t("sourceCountPlural", { count: r.sourceIndexes.length })}
                      </span>
                    </p>
                    {r.strands.length > 0 ? (
                      <p className="mt-1 text-xs leading-5 text-stone-600 dark:text-stone-400">
                        {t("strandsLabel", { strands: r.strands.join(", ") })}
                      </p>
                    ) : null}
                    {r.sections.length > 0 ? (
                      <p className="mt-0.5 text-xs leading-5 text-stone-700 dark:text-stone-300">
                        <span className="font-semibold">{t("sectionsLabel", { sections: r.sections.join(" · ") })}</span>
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            );
          })()}
        </section>
      ) : null}

      {/* Validation */}
      <section aria-labelledby="validation-heading" className={cardClass}>
        <h2 id="validation-heading" className="mb-3 text-base font-bold text-stone-900 dark:text-stone-100">
          {t("validationHeading")}
        </h2>
        {!hasDraft ? (
          <Empty title={t("nothingToCheckTitle")} hint={t("nothingToCheckHint")} />
        ) : issues.length === 0 ? (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
            {t("noValidationIssues")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {issues.map((issue, i) => (
              <li key={i} className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 dark:bg-amber-950/40">
                <span className="mt-0.5 shrink-0 rounded bg-amber-200/70 px-1.5 py-0.5 font-mono text-[11px] font-bold text-amber-900 dark:bg-amber-900/60 dark:text-amber-200">
                  {issue.code}
                </span>
                <span className="text-sm leading-6 text-stone-800 dark:text-stone-200">{issue.detail}</span>
              </li>
            ))}
          </ul>
        )}

        {coverage.length > 0 ? (
          <div className="mt-4">
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-stone-500 dark:text-stone-400">{t("coverageHeading")}</p>
            <ul className="flex flex-col gap-1.5">
              {coverage.map((c, i) => (
                <li key={i} className="flex items-start gap-2 text-sm leading-6 text-stone-800 dark:text-stone-200">
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                      c.met ? "bg-emerald-800 text-white dark:bg-emerald-700" : "bg-stone-300 text-stone-600 dark:bg-stone-700 dark:text-stone-400"
                    }`}
                  >
                    {c.met ? "✓" : "·"}
                  </span>
                  <span>
                    {c.item}
                    {c.location ? <span className="text-stone-500 dark:text-stone-400"> — {c.location}</span> : null}
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
