import { NextResponse } from "next/server";
import { z } from "zod";
import { completeJson, nimChatLong } from "@/lib/nim";
import { REFINE_SYSTEM } from "@/lib/prompts";
import { DraftSchema, WriterDraftSchema } from "@/lib/essay-types";
import { buildDocx, countWords } from "@/lib/docx-build";
import { validateDraft, prepareDraft, sourcesTextMap, splitSentences } from "@/lib/validate";
import { liveSearch, normalizeUrl, extractPages, buildSources } from "@/lib/search";
import type { SourceItem } from "@/lib/essay-types";
import { saveDocxFile } from "@/lib/docx-store";
import { prisma } from "@/lib/db";
import { auditAndAlignGrounding } from "@/lib/grounding-audit";
import { assertCitationMinimums, assertUncitedConclusion } from "@/lib/citation-limits";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  projectId: z.string().min(1),
  versionId: z.string().nullish(),
  instruction: z.string().min(1).max(10000),
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
    const today = new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    let newSources: SourceItem[] = [];
    let sourceBlock =
      "No new web pages were fetched for this revision; cite only existing footnotes or common knowledge.";
    try {
      const followQueries = [
        `${project.topic} ${body.instruction}`.trim().slice(0, 300),
        project.topic,
      ].filter((q, i, arr) => q.length > 0 && arr.indexOf(q) === i).slice(0, 3);
      const prohibitNewSources = /\b(?:do not|don't|without|no)\b[^.!?\n]{0,100}\bsources\b/i.test(body.instruction);
      const web = prohibitNewSources ? [] : await liveSearch(followQueries, 4);
      const fresh = web.filter((w) => !citedUrls.has(normalizeUrl(w.url))).slice(0, 4);
      if (fresh.length > 0) {
        const label = `this follow-up (“${body.instruction.slice(0, 80)}”)`;
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
    const trunc = (content: string) => content.length > 12000 ? content.slice(0, 12000) + "\n[truncated]" : content;
    const writerDbSources = dbSources
      .filter((s) => body.minimumSources > citedUrls.size || citedUrls.has(normalizeUrl(s.url)))
      .map(({ title, url, content }) => ({ title, url, content: trunc(content || "") }));
    const writerNewSources = newSources.map((s) => ({ ...s, content: trunc(s.content || "") }));

    const draft = await completeJson(
      {
        system: REFINE_SYSTEM,
        user: `Instruction sheet:\n${project.instruction}\n\nTopic: ${project.topic}\nWord target: ${project.wordTarget}\nMinimum footnotes: ${body.minimumFootnotes}\nMinimum distinct cited works: ${body.minimumSources}\nDevelop factual findings from at least this many different source URLs before writing. Cite at least the requested number of separate factual sentences; These are minimums, not exact counts or caps: you may use more footnotes and more distinct works when they support the essay. Do not add decorative citations.\n\nCurrent essay JSON:\n${baseEssayForWriter}\n\nExisting source texts:\n${JSON.stringify(writerDbSources)}\n\nUser revision instruction:\n${body.instruction}\n\n${sourceBlock.replace(JSON.stringify(newSources), JSON.stringify(writerNewSources))}\n\nReturn the revised essay JSON now.`,
        temperature: 0.7,
        maxTokens: Math.min(32768, Math.max(12000, project.wordTarget * 3 + 6000)),
        schema: WriterDraftSchema,
        responseFormat: { type: "json_object" },
        parseTries: 3,
        repairResponse: (draft) => JSON.stringify(draft),
        retryTempDelta: 0,
        validate: async (d) => {
          prepareDraft(d, sourcesText, { deferEvidence: true });
          assertUncitedConclusion(d);
          const audit = await auditAndAlignGrounding(d, [...dbSources, ...newSources]);
          assertUncitedConclusion(d);
          assertCitationMinimums(d, body.minimumFootnotes, body.minimumSources);
          const bodyEnd = d.introduction.length + d.sections.flatMap((section) => section.paragraphs).length;
          const bodyClaims = new Set(d.evidence.filter((item) => item.paragraph >= d.introduction.length && item.paragraph < bodyEnd).map((item) => item.source));
          if (bodyClaims.size < Math.max(1, Math.floor(project.wordTarget / 400))) {
            throw new Error(`Develop more directly supported source findings in the body. Currently only ${bodyClaims.size} factual findings are verified.`);
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
            if (d.introduction.length !== 1 || d.conclusion.length !== 1 || [...d.introduction, ...d.conclusion].some((paragraph) => proseWords(paragraph) < 30) || d.sections.some((section) => !section.paragraphs.length || section.paragraphs.some((paragraph) => proseWords(paragraph) < 60 || splitSentences(paragraph).length < 3))) {
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
    const wordCount = countWords(draft);
    const buffer = await buildDocx(draft);

    const latest = await prisma.essayVersion.findFirst({ where: { projectId: body.projectId }, orderBy: { version: "desc" } });
    const version = (latest?.version ?? base.version) + 1;
    const rel = await saveDocxFile(body.projectId, version, buffer);

    const summary =
      `Revision v${version}: ${body.instruction.slice(0, 140)} (${wordCount} words, ${draft.footnotes.length} footnotes).` +
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
