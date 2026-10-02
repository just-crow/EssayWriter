import { NextResponse } from "next/server";
import { z } from "zod";
import { completeJson } from "@/lib/nim";
import { DRAFT_SYSTEM, draftUserPrompt } from "@/lib/prompts";
import { writerDraftSchema, SourceItemSchema } from "@/lib/essay-types";
import { buildDocx, countWords } from "@/lib/docx-build";
import {
  validateDraft,
  prepareDraft,
  sourcesTextMap,
  splitSentences,
  consolidateSectionParagraphs,
} from "@/lib/validate";
import { saveDocxFile } from "@/lib/docx-store";
import { prisma } from "@/lib/db";
import { normalizeUrl, MAX_SOURCES_JSON_CHARS } from "@/lib/search";
import { auditAndAlignGrounding } from "@/lib/grounding-audit";
import { buildWritingPlan, composePlannedDraft, excludedFindingsFor } from "@/lib/planned-writer";
import { cleanTopicForRetrieval } from "@/lib/topic-hygiene";
import { structuralSectionRole } from "@/lib/paragraph-plan";
import { removeOffTopicProse } from "@/lib/topic-relevance";
import { groupCitationRuns } from "@/lib/citation-runs";
import { buildCoverage, rebuildWorksCited } from "@/lib/validate";
import { assertCitationMinimums, assertUncitedConclusion, citationCounts } from "@/lib/citation-limits";
import { workIdentity } from "@/lib/work-identity";
import { repairCitationMinimums } from "@/lib/citation-repair";
import { repairParagraphDepth } from "@/lib/paragraph-depth-repair";
import { plannedEvidence, snapshotDraft, type DraftDiagnostics } from "@/lib/draft-diagnostics";
import { ensureEssayEnds, missingEnds } from "@/lib/essay-endings";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  topic: z.string().min(1).max(500),
  instructionText: z.string().max(60000).default(""),
  extraInstructions: z.string().max(20000).default(""),
  wordTarget: z.number().int().min(200).max(10000).default(1200),
  minimumFootnotes: z.number().int().min(1).max(30).default(1),
  minimumSources: z.number().int().min(1).max(18).default(1),
  structureJson: z.string().min(2).max(30000),
  sourcesJson: z.string().min(2).max(MAX_SOURCES_JSON_CHARS),
  projectId: z.string().nullish(),
});

export async function POST(req: Request) {
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(290_000)]);
  try {
    const body = Body.parse(await req.json());
    try {
      z.object({ sections: z.array(z.unknown()).optional() }).parse(JSON.parse(body.structureJson));
    } catch {
      return NextResponse.json({ error: "The outline is invalid. Generate or select an outline before drafting." }, { status: 400 });
    }
    // Relevance matching must use the essay subject, not institutional
    // boilerplate pasted into the topic box (same cleaning as retrieval).
    let outlineThesis = "";
    try {
      outlineThesis = (JSON.parse(body.structureJson) as { thesis?: unknown }).thesis as string || "";
    } catch {
      // fall through with an empty thesis
    }
    const effectiveTopic = cleanTopicForRetrieval(body.topic, outlineThesis).topic || body.topic;
    // Source texts for grounding verification (quote checks run against these).
    let sourceItems;
    try {
      sourceItems = z.array(SourceItemSchema).parse(JSON.parse(body.sourcesJson));
    } catch {
      return NextResponse.json({ error: "The source list is invalid. Gather sources again before drafting." }, { status: 400 });
    }
    if (sourceItems.length === 0) return NextResponse.json({ error: "Gather sources before drafting." }, { status: 400 });
    const availableWorks = new Set(sourceItems.filter((source) => source.content.trim().length >= 40).map(workIdentity).filter(Boolean)).size;
    if (availableWorks < body.minimumSources) return NextResponse.json({ error: `Only ${availableWorks} distinct works have readable source text, but you requested ${body.minimumSources}. Gather more sources or lower the minimum cited works.` }, { status: 400 });
    const sourcesText = sourcesTextMap(sourceItems);
    // Planning needs the full observed bank. Global topic ranking previously
    // discarded section-specific evidence before the writer ever saw it.
    const selectedSources = sourceItems.filter(source => source.content.trim().length >= 40);
    const selectedWithIds = selectedSources.map((source, index) => ({ ...source, id: String(index + 1) }));
    const writingSources = selectedWithIds;
    // Minimums are targets, not gates: when the evidence bank cannot support
    // the requested floors, draft from what exists (floors of 1) and report
    // the shortfall as a warning instead of discarding the essay. Only a
    // truly empty bank still fails (nothing verifiable to write from).
    let writingInput = { ...body };
    let planNote: string | null = null;
    const buildPlan = () => buildWritingPlan(writingInput, writingSources);
    let plan: ReturnType<typeof buildPlan>;
    try {
      plan = buildPlan();
    } catch (err) {
      planNote = err instanceof Error ? err.message : String(err ?? "");
      writingInput = { ...body, minimumSources: 1, minimumFootnotes: 1 };
      plan = buildPlan();
    }
    const findings = JSON.stringify(plan);
    // Soft warnings collected during validation; appended to issues so the
    // essay ships with honest notes instead of failing outright.
    const softWarnings: Array<{ code: string; detail: string }> = [];
    if (planNote) {
      softWarnings.push({ code: "BELOW_MINIMUMS", detail: `Requested citation minimums reduced for this evidence bank: ${planNote} The essay is delivered as-is.` });
    }
    const diagnostics: DraftDiagnostics = {plan: plannedEvidence(plan.tasks, plan.headings), stages: [], removed: []};
    // Provider provenance for the UI: which models actually served this
    // essay (paid Luna vs fallback), in first-use order.
    const usedProviders: Array<"openrouter" | "nvidia"> = [];
    const noteProvider = (provider: "openrouter" | "nvidia") => {
      if (!usedProviders.includes(provider)) usedProviders.push(provider);
    };
    if (new Set(writingSources.map((source) => normalizeUrl(source.url))).size < body.minimumSources) return NextResponse.json({ error: `The selected pages did not provide factual findings from ${body.minimumSources} distinct works. Gather stronger sources or lower the minimum cited works.` }, { status: 400 });
    // The model starves when the source dump fills its context (18 x 100k).
    // Planning already selected findings; the writer only needs enough page
    // text to paraphrase accurately. Truncate per-source content for the
    // prompt while keeping full texts for server-side verification.
    const MAX_WRITER_CHARS_PER_SOURCE = 12000;
    const writerSources = writingSources.map((s) => ({
      ...s,
      content: s.content.length > MAX_WRITER_CHARS_PER_SOURCE
        ? s.content.slice(0, MAX_WRITER_CHARS_PER_SOURCE) + "\n[truncated]"
        : s.content,
    }));
    const draft = await completeJson(
      {
        system: DRAFT_SYSTEM,
        user: draftUserPrompt({ ...body, sourcesJson: JSON.stringify(writerSources), evidenceSpine: findings }),
        temperature: 0.7,
        maxTokens: Math.min(32768, Math.max(12000, body.wordTarget * 3 + 6000)),
        schema: writerDraftSchema(),
        // Use native JSON syntax constraints for prose. This NIM backend's
        // regex schema grammar can distort citations and paragraph strings.
        // Application schema, source checks and length checks still apply.
        responseFormat: { type: "json_object" },
        parseTries: 2,
        signal,
        repairResponse: (d) => {
          // Retain the already verified prose on a length/depth repair.
          // Translate verifier footnotes back to the writer's fixed source
          // IDs without changing any sentence's selected source URL.
          const fixed = new Map(writingSources.map((source) => [normalizeUrl(source.url), source.id]));
          const ids = new Map(d.footnotes.map((note) => [note.id, fixed.get(normalizeUrl(note.url))]));
          const rewrite = (text: string) => text.replace(/\[\^(\d+)\]/g, (marker, id: string) => ids.get(Number(id)) ? `[^${ids.get(Number(id))}]` : marker);
          return JSON.stringify({
            ...d,
            introduction: d.introduction.map(rewrite),
            sections: d.sections.map((section) => ({ ...section, paragraphs: section.paragraphs.map(rewrite) })),
            conclusion: d.conclusion.map(rewrite),
            footnotes: writingSources.map((source) => ({ id: Number(source.id), author: source.author, title: source.title, publisher: source.publisher || source.container, year: source.year, url: source.url, accessed: source.accessed })),
            evidence: [],
          });
        },
        // Keep Nemotron's recommended sampling on correction attempts too.
        retryTempDelta: 0,
        validate: async (d) => {
          diagnostics.stages = [snapshotDraft(d, "Writer")];
          diagnostics.removed = [];
          diagnostics.depthRepair = undefined;
          if (d.sections.some(section => structuralSectionRole(section.heading) !== null)) {
            throw new Error("Introduction and conclusion must appear only in their dedicated essay fields, not as cited body sections.");
          }
          d.footnotes = writingSources.map((source) => ({
            id: Number(source.id), author: source.author, title: source.title,
            publisher: source.publisher || source.container, year: source.year,
            url: source.url, accessed: source.accessed,
          }));
          prepareDraft(d, sourcesText, { deferEvidence: true });
          assertUncitedConclusion(d);
          // Auxiliary review: a provider outage here must not discard an
          // otherwise writable essay. The grounding audit below enforces
          // topicality independently (off-topic claims fail verification).
          let offTopic: string[] = [];
          try {
            offTopic = await removeOffTopicProse(d, effectiveTopic, signal, body.structureJson, noteProvider);
          } catch (error) {
            signal.throwIfAborted();
            diagnostics.topicReviewSkipped = error instanceof Error ? error.message : "Topic review unavailable.";
          }
          diagnostics.stages.push(snapshotDraft(d, "Topic review"));
          const audit = await auditAndAlignGrounding(d, sourceItems, { signal, batchSize: 2, fast: true, topic: effectiveTopic, onProvider: noteProvider });
          const removedClaims = [...offTopic, ...audit.removed];
          diagnostics.removed = removedClaims.slice(0, 40);
          diagnostics.stages.push(snapshotDraft(d, "Source verification"));
          // A vanished end is a retryable failure, never a silent skip: the
          // recomposition round reserves fresh evidence for the rewrite.
          const gone = missingEnds(d);
          if (gone.length > 0) {
            throw new Error(`The ${gone.join(" and ")} ${gone.length > 1 ? "are" : "is"} empty after source checks (every sentence was removed). Rewrite ${gone.length > 1 ? "them" : "it"} from the approved outline using only claims directly supported by the supplied page text.${removedClaims.length > 0 ? ` Removed:\n${removedClaims.slice(0, 8).join("\n")}` : ""}`);
          }
          ensureEssayEnds(d, body.topic);
          const removed = removedClaims.length > 0
            ? ` The review removed these off-topic or unsupported claims; replace them only with relevant claims directly supported by the supplied page text:\n${removedClaims.slice(0, 8).join("\n")}`
            : "";
          if (body.wordTarget >= 400) {
            consolidateSectionParagraphs(d);
          }
          groupCitationRuns(d);
          assertUncitedConclusion(d);
          const counts = citationCounts(d);
          if (counts.footnotes < body.minimumFootnotes || counts.works < body.minimumSources) {
            // Repair is best-effort: its own failure must not discard the essay.
            try {
              await repairCitationMinimums(d, body, writingSources, signal, noteProvider);
            } catch {
              signal.throwIfAborted();
            }
          }
          diagnostics.stages.push(snapshotDraft(d, "Citation check"));
          // Below-minimum essays ship with a warning, not an error: the reader
          // sees what verified plus an honest shortfall note.
          try {
            assertCitationMinimums(d, body.minimumFootnotes, body.minimumSources);
          } catch (err) {
            signal.throwIfAborted();
            softWarnings.push({ code: "BELOW_MINIMUMS", detail: `${err instanceof Error ? err.message : "Below requested citation minimums."} The essay is delivered as-is; gather stronger sources or lower the minimums for fuller coverage.` });
          }
          if (body.wordTarget >= 400) {
            // This optional pass extends only depleted sections with fresh,
            // independently checked findings. A provider outage must not
            // discard an otherwise valid source-verified essay.
            try {
              const expanded = structuredClone(d);
              const before = countWords(d);
              const improved = await repairParagraphDepth(expanded, body, writingSources, signal, noteProvider);
              if (improved) Object.assign(d, expanded);
              diagnostics.depthRepair = {attempted: true, addedWords: Math.max(0, countWords(d) - before)};
            }
            catch (error) {
              signal.throwIfAborted();
              diagnostics.depthRepair = {attempted: true, addedWords: 0,
                reason: error instanceof Error ? error.message : "The optional expansion did not complete."};
            }
          }
          diagnostics.stages.push(snapshotDraft(d, "Final"));
          diagnostics.providers = [...usedProviders];
          d.diagnostics = structuredClone(diagnostics);
          const bodyEnd = d.introduction.length + d.sections.flatMap((section) => section.paragraphs).length;
          const bodyClaims = new Set(d.evidence.filter((item) => item.paragraph >= d.introduction.length && item.paragraph < bodyEnd).map((item) => item.source));
          // Analysis and explicitly proposed designs can occupy paragraphs
          // without introducing external facts. Thinly supported essays ship
          // with a warning rather than failing, like citation minimums.
          if (bodyClaims.size < Math.max(1, Math.floor(body.wordTarget / 400))) {
            softWarnings.push({ code: "BELOW_MINIMUMS", detail: `Only ${bodyClaims.size} directly supported finding${bodyClaims.size === 1 ? "" : "s"} in the body. The essay is delivered as-is; gather stronger sources for deeper coverage.` });
          }
          const words = countWords(d);
          if (Math.abs(words - body.wordTarget) > 400) {
            throw new Error(`The grounded essay is ${words} words. Revise it to stay within 400 words of the ${body.wordTarget}-word target.${removed}`);
          }
          if (body.wordTarget >= 400) {
            const sectionParagraphs = d.sections.flatMap((section) => section.paragraphs);
            const unusable = sectionParagraphs.filter((paragraph) => {
              const paragraphWords = paragraph.replace(/\[\^\d+\]/g, "").split(/\s+/).filter(Boolean).length;
              return splitSentences(paragraph).length < 2 || paragraphWords < 25;
            });
            const maxParagraphs = Math.max(4, Math.ceil(body.wordTarget / 75));
            if (unusable.length > 0 || sectionParagraphs.length > maxParagraphs || d.introduction.length !== 1 || d.conclusion.length !== 1) {
              throw new Error(`Use one introduction, one conclusion, and no more than ${maxParagraphs} developed section paragraphs. Every section paragraph needs at least 2 sentences and 25 words. Currently ${unusable.length} section paragraphs are unusable.${removed}`);
            }
          }
        },
        // Source synthesis needs reasoning: nonthinking live runs repeatedly
        // returned the same uncited template despite correction feedback.
        thinking: true,
        lowEffort: true,
        reasoningBudget: 1024,
      },
      async (params) => {
        const failure = params.user.split("VALIDATION FAILURE:\n")[1]?.split("\n\nPREVIOUS RESPONSE:")[0] || "";
        const priorJson = params.user.split("\n\nPREVIOUS RESPONSE:\n")[1]?.split("\n\nReturn one complete corrected JSON object")[0];
        // The slice can be truncated or contain model chatter; a failed parse
        // must fall back to unguided recomposition, never crash the draft.
        let previous: ReturnType<ReturnType<typeof writerDraftSchema>["safeParse"]> | undefined;
        if (priorJson) {
          try {
            previous = writerDraftSchema().safeParse(JSON.parse(priorJson));
          } catch {
            previous = undefined;
          }
        }
        signal.throwIfAborted();
        // The inner composition already retries once with the missing-IDs
        // feedback. If the model still omits reserved works (or source IDs /
        // word budget), one guided recomposition usually fixes it — failing
        // the whole draft on a single bad composition wastes every prior
        // stage. Transport/service errors already exhausted their retries
        // inside and are rethrown immediately.
        let guided = failure;
        let last: unknown = null;
        // Findings deleted by verification in one round are excluded from the
        // next round's plan, so recomposition develops fresh passages instead
        // of re-citing the same failed evidence.
        const excluded: string[] = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            return JSON.stringify(await composePlannedDraft({ ...writingInput, excludeFindings: excluded.length ? excluded : undefined }, writingSources, guided, previous?.success ? previous.data : undefined, signal, noteProvider));
          } catch (e) {
            last = e;
            signal.throwIfAborted();
            const msg = e instanceof Error ? e.message : String(e ?? "");
            if (!/omitted reserved works|Use only (the )?(planned )?source IDs|word synopsis|approximately .* words|cited 0 distinct works|below the requested|needs at least one citation|with \[\^sourceId\] markers|toward their word budgets|developed conclusion|evidence limits|review removed|audit removed|No factual claims|no usable in-text citations|directly supported findings|outside the .*word target tolerance|developed section paragraphs|no more than \d+ developed|empty after source checks/i.test(msg)) throw e;
            const assignedTexts = plan.tasks.flatMap((task) => task.assigned.map((finding) => finding.text));
            for (const key of excludedFindingsFor(diagnostics.removed, assignedTexts)) {
              if (!excluded.includes(key)) excluded.push(key);
            }
            guided = `${failure}\n${msg}\nReserve strictly unused findings: do not cite evidence already removed above; develop different passages instead.`.trim();
          }
        }
        throw last;
      }
    );
    // Repairs append footnotes after the audit's bibliography rebuild, so
    // rebuild here or the persisted list misses the repaired citations.
    rebuildWorksCited(draft);
    const issues = validateDraft(draft);
    issues.push(...softWarnings);
    const wordCount = countWords(draft);
    // Agent-style coverage report: every outline requirement located in the
    // essay, plus the word-target row from the actual count.
    try {
      const checklist = (JSON.parse(body.structureJson) as { checklist?: unknown }).checklist;
      draft.coverage = Array.isArray(checklist)
        ? [...buildCoverage(checklist.filter((c): c is string => typeof c === "string"), draft),
          { item: `Meet the ${body.wordTarget}-word target`, met: Math.abs(wordCount - body.wordTarget) <= 400, location: `${wordCount} words` }]
        : draft.coverage;
    } catch {
      // keep the writer's coverage when the outline cannot be read
    }
    if (body.wordTarget >= 600 && wordCount < Math.ceil(body.wordTarget * 0.85)) {
      issues.push({code: "BELOW_TARGET_DEPTH", detail: `The verified essay is ${wordCount} words for a ${body.wordTarget}-word target. Source checks removed unsupported material; review the draft trace for depleted sections.`});
    }
    const worksCitedCount = citationCounts(draft).works;
    const buffer = await buildDocx(draft);

    let projectId = body.projectId;
    if (!projectId) {
      const p = await prisma.project.create({
        data: {
          title: draft.title.slice(0, 120) || body.topic.slice(0, 120),
          topic: body.topic,
          instruction: body.instructionText.slice(0, 20000),
          wordTarget: body.wordTarget,
        },
      });
      projectId = p.id;
    }

    // Persist the exact texts used here too (API callers can skip the source
    // endpoint). Refinement needs them to verify the saved evidence.
    const savedSources = await prisma.source.findMany({ where: { projectId } });
    for (const source of sourceItems) {
      if (savedSources.some((s) => normalizeUrl(s.url) === normalizeUrl(source.url) && s.content === source.content)) continue;
      await prisma.source.create({ data: { projectId, ...source, publisher: source.publisher || source.container } });
    }
    const latest = await prisma.essayVersion.findFirst({ where: { projectId }, orderBy: { version: "desc" } });
    const version = (latest?.version ?? 0) + 1;
    const docxPath = await saveDocxFile(projectId, version, buffer);
    const summary = `${draft.title} (${wordCount} words, ${draft.footnotes.length} footnotes, ${worksCitedCount} cited). Coverage: ${draft.coverage.filter((c) => c.met).length}/${draft.coverage.length} met.`;

    const record = await prisma.essayVersion.create({
      data: {
        projectId,
        version,
        title: draft.title,
        essayJson: JSON.stringify(draft),
        docxPath,
        wordCount,
        footnoteCount: draft.footnotes.length,
        summary,
      },
    });

    await prisma.project.update({
      where: { id: projectId },
      data: { title: draft.title.slice(0, 120), updatedAt: new Date() },
    });

    return NextResponse.json({
      projectId,
      versionId: record.id,
      version,
      draft,
      wordCount,
      footnoteCount: draft.footnotes.length,
      worksCitedCount,
      issues,
      summary,
      downloadUrl: `/api/download/${record.id}`,
    });
  } catch (err) {
    if (signal.aborted) return NextResponse.json({error: req.signal.aborted ? "Drafting was cancelled." : "The model service did not finish drafting and source checks within 5 minutes. Please try again when the service is responsive."}, {status: req.signal.aborted ? 499 : 504});
    const message = err instanceof Error ? err.message : "Draft failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
