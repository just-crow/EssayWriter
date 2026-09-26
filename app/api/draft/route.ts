import { NextResponse } from "next/server";
import { z } from "zod";
import { completeJson, nimChatLong } from "@/lib/nim";
import { DRAFT_SYSTEM, draftUserPrompt } from "@/lib/prompts";
import { DraftSchema, SourceItemSchema } from "@/lib/essay-types";
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
import { normalizeUrl } from "@/lib/search";
import { auditAndAlignGrounding } from "@/lib/grounding-audit";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  topic: z.string().min(1).max(500),
  instructionText: z.string().max(60000).default(""),
  extraInstructions: z.string().max(20000).default(""),
  wordTarget: z.number().int().min(200).max(10000).default(1200),
  structureJson: z.string().min(2).max(30000),
  sourcesJson: z.string().min(2).max(200000),
  projectId: z.string().nullish(),
});

export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    // Source texts for grounding verification (quote checks run against these).
    let sourceItems;
    try {
      sourceItems = z.array(SourceItemSchema).parse(JSON.parse(body.sourcesJson));
    } catch {
      return NextResponse.json({ error: "The source list is invalid. Gather sources again before drafting." }, { status: 400 });
    }
    if (sourceItems.length === 0) return NextResponse.json({ error: "Gather sources before drafting." }, { status: 400 });
    const sourcesText = sourcesTextMap(sourceItems);
    const draft = await completeJson(
      {
        system: DRAFT_SYSTEM,
        user: draftUserPrompt(body),
        temperature: 0.6,
        maxTokens: Math.min(32768, Math.max(20000, body.wordTarget * 4 + 6000)),
        schema: DraftSchema,
        parseTries: 3,
        // Cooler retry: verbatim quotes and strict shape need discipline,
        // not creativity.
        retryTempDelta: -0.3,
        validate: async (d) => {
          prepareDraft(d, sourcesText);
          const audit = await auditAndAlignGrounding(d, sourceItems);
          if (body.wordTarget >= 400) {
            consolidateSectionParagraphs(d);
          }
          const removed = audit.removed.length > 0
            ? ` The source audit removed these unsupported claims; replace them only with claims directly supported by the supplied page text:\n${audit.removed.slice(0, 8).join("\n")}`
            : "";
          const words = countWords(d);
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
            if (shallow.length > 0 || sectionParagraphs.length > maxParagraphs || d.introduction.length !== 1 || d.conclusion.length !== 1) {
              throw new Error(`Use one introduction, one conclusion, and no more than ${maxParagraphs} developed section paragraphs. Every section paragraph needs at least 3 sentences and 60 words. Currently ${shallow.length} section paragraphs are too short.${removed}`);
            }
          }
        },
        // Long output: disable chain-of-thought so the token budget goes
        // to the essay instead of 40k+ chars of reasoning.
        thinking: false,
      },
      nimChatLong
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
