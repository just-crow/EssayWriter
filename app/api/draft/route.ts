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
  assertNoRepeatedSentences,
} from "@/lib/validate";
import { saveDocxFile } from "@/lib/docx-store";
import { prisma } from "@/lib/db";
import { normalizeUrl } from "@/lib/search";
import { auditAndAlignGrounding } from "@/lib/grounding-audit";
import { selectWritingEvidence } from "@/lib/evidence-plan";
import { evidenceSpine } from "@/lib/evidence-spine";
import { composeSourceDraft } from "@/lib/source-writer";
import { groupCitationRuns } from "@/lib/citation-runs";
import { assertCitationMinimums } from "@/lib/citation-limits";

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
  sourcesJson: z.string().min(2).max(200000),
  projectId: z.string().nullish(),
});

export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    try {
      z.object({ sections: z.array(z.unknown()).optional() }).parse(JSON.parse(body.structureJson));
    } catch {
      return NextResponse.json({ error: "The outline is invalid. Generate or select an outline before drafting." }, { status: 400 });
    }
    // Source texts for grounding verification (quote checks run against these).
    let sourceItems;
    try {
      sourceItems = z.array(SourceItemSchema).parse(JSON.parse(body.sourcesJson));
    } catch {
      return NextResponse.json({ error: "The source list is invalid. Gather sources again before drafting." }, { status: 400 });
    }
    if (sourceItems.length === 0) return NextResponse.json({ error: "Gather sources before drafting." }, { status: 400 });
    const availableWorks = new Set(sourceItems.filter((source) => source.content.trim().length >= 40).map((source) => normalizeUrl(source.url))).size;
    if (availableWorks < body.minimumSources) return NextResponse.json({ error: `Only ${availableWorks} distinct works have readable source text, but you requested ${body.minimumSources}. Gather more sources or lower the minimum cited works.` }, { status: 400 });
    const sourcesText = sourcesTextMap(sourceItems);
    const selectedSources = await selectWritingEvidence(sourceItems, `${body.topic}\nTarget: ${body.wordTarget} words\nMinimum: ${body.minimumFootnotes} footnotes from ${body.minimumSources} distinct works\n${body.instructionText}\n${body.extraInstructions}\nOutline: ${body.structureJson}`, { minimumCharacters: body.wordTarget * 8, minimumSources: body.minimumSources });
    const selectedWithIds = selectedSources.map((source, index) => ({ ...source, id: String(index + 1) }));
    const findings = evidenceSpine(selectedWithIds, sourceItems, Math.max(12, Math.ceil(body.wordTarget / 20), body.minimumFootnotes), body.minimumSources);
    const findingItems = JSON.parse(findings) as Array<{ sourceId: string; text: string }>;
    // Compose from the concrete findings chosen before writing. Sending every
    // peripheral selected page again lets promotional claims overwhelm this
    // plan. The auditor still checks the original, unmodified page snapshots.
    const writingSources = findingItems.length ? selectedWithIds.filter((source) => findingItems.some((item) => item.sourceId === source.id))
      .map((source) => ({ ...source, content: findingItems.filter((item) => item.sourceId === source.id).map((item) => item.text).join("\n\n") })) : selectedWithIds;
    if (new Set(writingSources.map((source) => normalizeUrl(source.url))).size < body.minimumSources) return NextResponse.json({ error: `The selected pages did not provide factual findings from ${body.minimumSources} distinct works. Gather stronger sources or lower the minimum cited works.` }, { status: 400 });
    const draft = await completeJson(
      {
        system: DRAFT_SYSTEM,
        user: draftUserPrompt({ ...body, sourcesJson: JSON.stringify(writingSources), evidenceSpine: findings }),
        temperature: 1,
        maxTokens: Math.min(32768, Math.max(12000, body.wordTarget * 3 + 6000)),
        schema: writerDraftSchema(),
        // Use native JSON syntax constraints for prose. This NIM backend's
        // regex schema grammar can distort citations and paragraph strings.
        // Application schema, source checks and length checks still apply.
        responseFormat: { type: "json_object" },
        parseTries: 3,
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
          d.footnotes = writingSources.map((source) => ({
            id: Number(source.id), author: source.author, title: source.title,
            publisher: source.publisher || source.container, year: source.year,
            url: source.url, accessed: source.accessed,
          }));
          prepareDraft(d, sourcesText, { deferEvidence: true });
          const audit = await auditAndAlignGrounding(d, sourceItems);
          const removed = audit.removed.length > 0
            ? ` The source audit removed these unsupported claims; replace them only with claims directly supported by the supplied page text:\n${audit.removed.slice(0, 8).join("\n")}`
            : "";
          if (body.wordTarget >= 400) {
            consolidateSectionParagraphs(d);
          }
          groupCitationRuns(d);
          assertCitationMinimums(d, body.minimumFootnotes, body.minimumSources);
          const bodyEnd = d.introduction.length + d.sections.flatMap((section) => section.paragraphs).length;
          const bodyClaims = new Set(d.evidence.filter((item) => item.paragraph >= d.introduction.length && item.paragraph < bodyEnd).map((item) => item.source));
          // Analysis and explicitly proposed designs can occupy paragraphs
          // without introducing external facts. Require substantive verified
          // findings across the essay, rather than fabricating a fact solely
          // to put a citation in every recommendation paragraph.
          if (bodyClaims.size < Math.max(1, Math.floor(body.wordTarget / 400))) {
            throw new Error(`Develop more factual findings from the selected passages to support the essay's analysis. The body has only ${bodyClaims.size} directly supported findings.${removed}`);
          }
          const words = countWords(d);
          assertNoRepeatedSentences(d);
          if (Math.abs(words - body.wordTarget) > 400) {
            throw new Error(`The grounded essay is ${words} words. Revise it to stay within 400 words of the ${body.wordTarget}-word target.${removed}`);
          }
          if (body.wordTarget >= 400) {
            const sectionParagraphs = d.sections.flatMap((section) => section.paragraphs);
            const shallow = sectionParagraphs.filter((paragraph) => {
              const paragraphWords = paragraph.replace(/\[\^\d+\]/g, "").split(/\s+/).filter(Boolean).length;
              return splitSentences(paragraph).length < 3 || paragraphWords < 60;
            });
            const maxParagraphs = Math.max(4, Math.ceil(body.wordTarget / 75));
            const incompleteEnds = [...d.introduction, ...d.conclusion].some((paragraph) => paragraph.replace(/\[\^\d+\]/g, "").split(/\s+/).filter(Boolean).length < 30);
            if (shallow.length > 0 || sectionParagraphs.length > maxParagraphs || d.introduction.length !== 1 || d.conclusion.length !== 1 || incompleteEnds) {
              throw new Error(`Use one introduction, one conclusion, and no more than ${maxParagraphs} developed section paragraphs. Every section paragraph needs at least 3 sentences and 60 words. Currently ${shallow.length} section paragraphs are too short.${removed}`);
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
        const previous = priorJson ? writerDraftSchema().safeParse(JSON.parse(priorJson)) : undefined;
        return JSON.stringify(await composeSourceDraft(body, writingSources, failure, previous?.success ? previous.data : undefined));
      }
    );
    const issues = validateDraft(draft);
    const wordCount = countWords(draft);
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
    const summary = `${draft.title} (${wordCount} words, ${draft.footnotes.length} footnotes, ${draft.worksCited.length} cited). Coverage: ${draft.coverage.filter((c) => c.met).length}/${draft.coverage.length} met.`;

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
      worksCitedCount: draft.worksCited.length,
      issues,
      summary,
      downloadUrl: `/api/download/${record.id}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Draft failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
