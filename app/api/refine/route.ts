import { NextResponse } from "next/server";
import { z } from "zod";
import { completeJson, nimChatLong } from "@/lib/nim";
import { REFINE_SYSTEM } from "@/lib/prompts";
import { DraftSchema, WriterDraftSchema } from "@/lib/essay-types";
import { buildDocx, countWords } from "@/lib/docx-build";
import { validateDraft, prepareDraft, sourcesTextMap, splitSentences, normQuote } from "@/lib/validate";
import { missingEnds } from "@/lib/essay-endings";
import { liveSearch, normalizeUrl, extractPages, buildSources } from "@/lib/search";
import type { SourceItem } from "@/lib/essay-types";
import { saveDocxFile } from "@/lib/docx-store";
import { prisma } from "@/lib/db";
import { auditAndAlignGrounding } from "@/lib/grounding-audit";
import { assertCitationMinimums, assertUncitedConclusion } from "@/lib/citation-limits";
import { cleanTopicForRetrieval } from "@/lib/topic-hygiene";
import {
  cutAtWord,
  dropDanglingMarkers,
  missingVerbatim,
  needsNewSources,
  normalizeVerbatimTarget,
  placeVerbatim,
  resolveVerbatimTarget,
  splitPastedMaterial,
  userSentenceSet,
  type VerbatimPlacement,
} from "@/lib/refine-intent";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  projectId: z.string().min(1),
  versionId: z.string().nullish(),
  instruction: z.string().min(1).max(10000),
  /** Optional prose to insert exactly as written (separate UI field). */
  verbatimText: z.string().max(20000).default(""),
  /** Where to put it: "introduction" | "conclusion" | section heading. */
  verbatimTarget: z.string().max(200).default(""),
  minimumFootnotes: z.number().int().min(1).max(30).default(1),
  minimumSources: z.number().int().min(1).max(18).default(1),
});

export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    const project = await prisma.project.findUnique({ where: { id: body.projectId } });
    if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });

    const base = body.versionId
      ? await prisma.essayVersion.findUnique({ where: { id: body.versionId } })
      : await prisma.essayVersion.findFirst({
          where: { projectId: body.projectId },
          orderBy: { version: "desc" },
        });
    if (!base) return NextResponse.json({ error: "No essay version to refine yet." }, { status: 400 });
    if (base.projectId !== body.projectId) return NextResponse.json({ error: "This essay version belongs to a different project." }, { status: 400 });

    await prisma.chatMessage.create({
      data: { projectId: body.projectId, role: "user", content: body.instruction.slice(0, 10000) },
    });

    // Follow-up source power: fetch fresh verified pages for this revision
    // so new claims can be cited instead of invented. URLs already cited in
    // the base essay are skipped. Never fails the revision — worst case the
    // model works from existing footnotes plus common knowledge.
    const citedUrls = new Set<string>();
    let maxFnId = 0;
    let baseEssayForWriter = base.essayJson;
    try {
      const baseDraft = DraftSchema.parse(JSON.parse(base.essayJson));
      baseEssayForWriter = JSON.stringify({...baseDraft, diagnostics: undefined});
      for (const f of baseDraft.footnotes) {
        if (f.url) citedUrls.add(normalizeUrl(f.url));
        if (typeof f.id === "number" && f.id > maxFnId) maxFnId = f.id;
      }
    } catch {
      // fall through with empty sets
    }
    // Separate directives (what to do) from pasted prose (material to place
    // verbatim). Pasted text is never instructions and never needs paraphrase.
    const intent = splitPastedMaterial(body.instruction);
    const verbatim = body.verbatimText.trim() || intent.pasted;
    const preserveTexts = [...userSentenceSet(verbatim)];

    // Mechanically pre-place user text on a working copy so the model sees it
    // in situ; the post-check below still enforces verbatim survival.
    let placement: VerbatimPlacement = { applied: false, targetLabel: "", part: null, sectionIndex: null, heading: null };
    try {
      const parsed = DraftSchema.parse(JSON.parse(base.essayJson));
      const working = structuredClone(parsed);
      if (verbatim) {
        const headings = parsed.sections.map((s) => s.heading);
        const explicit = normalizeVerbatimTarget(body.verbatimTarget);
        const target = explicit || resolveVerbatimTarget("", intent.directives, headings);
        placement = placeVerbatim(working, target, verbatim);
      }
      baseEssayForWriter = JSON.stringify({ ...working, diagnostics: undefined });
    } catch {
      // fall through with the raw essay JSON
    }

    const today = new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    let newSources: SourceItem[] = [];
    let sourceBlock =
      "No new web pages were fetched for this revision; cite only existing footnotes or common knowledge.";
    try {
      const queryBasis = intent.directives || body.instruction;
      // Stored topics can hold pasted institutional headers; search the
      // cleaned subject so follow-up queries stay on the essay theme.
      const queryTopic = cleanTopicForRetrieval(project.topic).topic || project.topic;
      const followQueries = [
        `${queryTopic} ${queryBasis}`.trim().slice(0, 300),
        queryTopic,
      ].filter((q, i, arr) => q.length > 0 && arr.indexOf(q) === i).slice(0, 3);
      const prohibitNewSources = /\b(?:do not|don't|without|no)\b[^.!?\n]{0,100}\bsources\b/i.test(body.instruction);
      // Pure replacement / shortening / restructuring of supplied or existing
      // material needs no fresh research; anything else keeps fetching.
      const wantSources = needsNewSources(intent.directives, verbatim.length > 0);
      const web = prohibitNewSources || !wantSources ? [] : await liveSearch(followQueries, 4);
      const fresh = web.filter((w) => !citedUrls.has(normalizeUrl(w.url))).slice(0, 4);
      if (fresh.length > 0) {
        const label = `this follow-up (“${cutAtWord(intent.directives || body.instruction, 80)}”)`;
        const labels = new Map(fresh.map((w) => [w.query, label]));
        const built = buildSources(fresh, labels, today);
        const texts = await extractPages(built.map((s) => s.url));
        const snippets = new Map(fresh.map((w) => [normalizeUrl(w.url), w.snippet]));
        newSources = built.map((s) => ({
          ...s,
          content: texts.get(normalizeUrl(s.url || "")) || snippets.get(normalizeUrl(s.url || "")) || "",
        }));
        for (const s of newSources) {
          await prisma.source.create({
            data: {
              projectId: body.projectId,
              author: s.author,
              title: s.title,
              publisher: s.publisher || s.container,
              year: s.year,
              url: s.url,
              accessed: s.accessed,
              supports: s.supports,
              content: s.content,
            },
          });
        }
        sourceBlock =
          `Additional verified source texts you MAY cite for new claims in this revision ` +
          `(each has title, URL, page text in "content"):\n${JSON.stringify(newSources)}\n` +
          `New footnotes MUST continue numbering after ${maxFnId} (existing footnotes keep their ids). ` +
          `If the revision needs no new facts, cite existing footnotes or common knowledge instead and ignore these.`;
      }
    } catch {
      // search/extract failure must never break the revision itself
    }

    // Grounding context for the revision: texts of all project sources
    // plus the freshly fetched ones.
    const dbSources = await prisma.source.findMany({ where: { projectId: body.projectId } });
    const sourcesText = sourcesTextMap([...dbSources, ...newSources]);
    // Provider provenance, same as the draft route.
    const usedProviders: Array<"openrouter" | "nvidia"> = [];
    const noteProvider = (provider: "openrouter" | "nvidia") => {
      if (!usedProviders.includes(provider)) usedProviders.push(provider);
    };
    // Below-minimum outcomes ship with warnings, not errors.
    const softWarnings: Array<{ code: string; detail: string }> = [];
    const trunc = (content: string) => content.length > 12000 ? content.slice(0, 12000) + "\n[truncated]" : content;
    const writerDbSources = dbSources
      .filter((s) => body.minimumSources > citedUrls.size || citedUrls.has(normalizeUrl(s.url)))
      .map(({ title, url, content }) => ({ title, url, content: trunc(content || "") }));
    const writerNewSources = newSources.map((s) => ({ ...s, content: trunc(s.content || "") }));

    const draft = await completeJson(
      {
        system: REFINE_SYSTEM,
        user: `Instruction sheet:\n${project.instruction}\n\nTopic: ${project.topic}\nWord target: ${project.wordTarget}\nMinimum footnotes: ${body.minimumFootnotes}\nMinimum distinct cited works: ${body.minimumSources}\nDevelop factual findings from at least this many different source URLs before writing. Cite at least the requested number of separate factual sentences; These are minimums, not exact counts or caps: you may use more footnotes and more distinct works when they support the essay. Do not add decorative citations.\n\nCurrent essay JSON:\n${baseEssayForWriter}\n\nExisting source texts:\n${JSON.stringify(writerDbSources)}\n\nUser directives (what to do):\n${intent.directives || body.instruction}\n\nUSER-SUPPLIED TEXT (place verbatim where directed${placement.targetLabel ? ` at ${placement.targetLabel}` : ""}; do not paraphrase, shorten, or improve it):\n${verbatim || "None — compose all prose yourself."}\n\nPlacement: ${placement.targetLabel ? `already applied at ${placement.targetLabel}; preserve it exactly` : verbatim ? "infer the location from the directives" : "no supplied text; revise per the directives"}\n\n${sourceBlock.replace(JSON.stringify(newSources), JSON.stringify(writerNewSources))}\n\nReturn the revised essay JSON now.`,
        temperature: 0.7,
        onProvider: noteProvider,
        maxTokens: Math.min(32768, Math.max(12000, project.wordTarget * 3 + 6000)),
        schema: WriterDraftSchema,
        responseFormat: { type: "json_object" },
        parseTries: 3,
        repairResponse: (draft) => JSON.stringify(draft),
        retryTempDelta: 0,
        validate: async (d) => {
          // Pasted markers may reference old numbering; drop dangling ones
          // instead of failing — the prose itself is preserved below.
          dropDanglingMarkers(d);
          prepareDraft(d, sourcesText, { deferEvidence: true });
          assertUncitedConclusion(d);
          if (preserveTexts.length > 0) {
            const allText = [...d.introduction, ...d.sections.flatMap((s) => s.paragraphs), ...d.conclusion].join("\n");
            const missing = missingVerbatim(allText, new Set(preserveTexts));
            if (missing.length > 0) {
              throw new Error(`The supplied user text must appear verbatim in the essay. Restore these sentences exactly as given, without paraphrasing:\n${missing.slice(0, 6).join("\n")}`);
            }
            // A replaced part holds ONLY the supplied text: the model may not
            // pad it with extra sentences around the user's wording.
            if (placement.applied) {
              const partTexts: string[] =
                placement.part === "introduction" ? d.introduction
                : placement.part === "conclusion" ? d.conclusion
                : placement.heading ? (d.sections.find((s) => s.heading === placement.heading)?.paragraphs ?? []) : [];
              const userSet = new Set(preserveTexts);
              const extras = partTexts
                .flatMap((p) => splitSentences(p))
                .map((s) => s.trim())
                .filter((s) => s && !userSet.has(normQuote(s.replace(/\[\^\d+\]/g, "").trim())));
              if (extras.length > 0) {
                throw new Error(`The ${placement.targetLabel} must contain only the supplied user text. Remove the added sentences and keep the supplied wording exactly.`);
              }
            }
          }
          // A revision that strips every citation marker leaves the audit with
          // nothing to verify (its exact historical failure). Fail fast with
          // guidance instead of a cryptic verification error.
          const citedAnywhere = [...d.introduction, ...d.sections.flatMap((s) => s.paragraphs)].some((p) => /\[\^\d+\]/.test(p));
          if (!citedAnywhere) {
            throw new Error("The revision cites no sources: every [^n] footnote marker is gone. Preserve the essay's existing citation markers on factual sentences instead of removing them.");
          }
          const audit = await auditAndAlignGrounding(d, [...dbSources, ...newSources], { onProvider: noteProvider, preserveTexts });
          assertUncitedConclusion(d);
          // A vanished end is a retryable failure, never a silent skip: the
          // model restores it from the established essay on the next attempt.
          // (This exact failure emptied three historical revisions.)
          const gone = missingEnds(d);
          if (gone.length > 0) {
            throw new Error(`The ${gone.join(" and ")} ${gone.length > 1 ? "are" : "is"} empty after source checks (every sentence was removed). Restore ${gone.length > 1 ? "them" : "it"} from the established essay using only supported claims.${audit.removed.length > 0 ? ` Removed:\n${audit.removed.slice(0, 8).join("\n")}` : ""}`);
          }
          try {
            assertCitationMinimums(d, body.minimumFootnotes, body.minimumSources);
          } catch (err) {
            softWarnings.push({ code: "BELOW_MINIMUMS", detail: `${err instanceof Error ? err.message : "Below requested citation minimums."} The revision is delivered as-is.` });
          }
          const bodyEnd = d.introduction.length + d.sections.flatMap((section) => section.paragraphs).length;
          const bodyClaims = new Set(d.evidence.filter((item) => item.paragraph >= d.introduction.length && item.paragraph < bodyEnd).map((item) => item.source));
          if (bodyClaims.size < Math.max(1, Math.floor(project.wordTarget / 400))) {
            softWarnings.push({ code: "BELOW_MINIMUMS", detail: `Only ${bodyClaims.size} directly supported finding${bodyClaims.size === 1 ? "" : "s"} in the body. The revision is delivered as-is.` });
          }
          const removed = audit.removed.length > 0
            ? ` The source audit removed these unsupported claims; replace them only with directly supported statements:\n${audit.removed.slice(0, 8).join("\n")}`
            : "";
          const words = countWords(d);
          if (Math.abs(words - project.wordTarget) > 400) {
            throw new Error(`The grounded revision is ${words} words. Keep it within 400 words of the ${project.wordTarget}-word target.${removed}`);
          }
          if (project.wordTarget >= 400) {
            const proseWords = (paragraph: string) => paragraph.replace(/\[\^\d+\]/g, "").split(/\s+/).filter(Boolean).length;
            // Mechanically replaced parts belong to the author: their shape
            // is exempt from minimums (word-target and citation floors still
            // apply to the essay as a whole).
            const replacedSection = placement.part === "section" ? placement.sectionIndex : null;
            const introOk = placement.part === "introduction" || (d.introduction.length === 1 && proseWords(d.introduction[0]) >= 30);
            const conclOk = placement.part === "conclusion" || (d.conclusion.length === 1 && proseWords(d.conclusion[0]) >= 30);
            const sectionsOk = d.sections.every((section, index) => {
              if (index === replacedSection) return section.paragraphs.length > 0;
              return section.paragraphs.length > 0 && section.paragraphs.every((paragraph) => proseWords(paragraph) >= 60 && splitSentences(paragraph).length >= 3);
            });
            if (!introOk || !conclOk || !sectionsOk) {
              throw new Error("Preserve one complete introduction, one complete conclusion, and developed body paragraphs of at least three sentences and 60 words.");
            }
          }
        },
        thinking: true,
        lowEffort: true,
        reasoningBudget: 1024,
      },
      nimChatLong
    );
    const issues = validateDraft(draft);
    issues.push(...softWarnings);
    // Minimal diagnostics so the UI can report which providers served this
    // revision (full stage history is a draft-route feature).
    draft.diagnostics = { plan: [], stages: [], removed: [], providers: [...usedProviders] };
    const wordCount = countWords(draft);
    const buffer = await buildDocx(draft);

    const latest = await prisma.essayVersion.findFirst({ where: { projectId: body.projectId }, orderBy: { version: "desc" } });
    const version = (latest?.version ?? base.version) + 1;
    const rel = await saveDocxFile(body.projectId, version, buffer);

    // Summarize the action, not the raw message: pasted prose would flood
    // the log (and previously truncated mid-word).
    const actionBits = [
      placement.targetLabel ? `Replace ${placement.targetLabel} with supplied text` : verbatim ? "Insert supplied text" : "",
      cutAtWord(intent.directives, placement.targetLabel || verbatim ? 80 : 140),
    ].filter(Boolean);
    const summary =
      `Revision v${version}: ${actionBits.join(" — ") || "Revision"} (${wordCount} words, ${draft.footnotes.length} footnotes).` +
      (newSources.length > 0 ? ` Found ${newSources.length} new source${newSources.length === 1 ? "" : "s"} for this revision.` : "");
    const record = await prisma.essayVersion.create({
      data: {
        projectId: body.projectId,
        version,
        title: draft.title,
        essayJson: JSON.stringify(draft),
        docxPath: rel,
        wordCount,
        footnoteCount: draft.footnotes.length,
        summary,
      },
    });
    await prisma.chatMessage.create({
      data: { projectId: body.projectId, role: "assistant", content: summary },
    });

    return NextResponse.json({
      projectId: body.projectId,
      versionId: record.id,
      version,
      draft,
      wordCount,
      footnoteCount: draft.footnotes.length,
      issues,
      summary,
      downloadUrl: `/api/download/${record.id}`,
      newSources,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Refine failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
