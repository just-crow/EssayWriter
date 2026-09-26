import { NextResponse } from "next/server";
import { z } from "zod";
import { completeJson, nimChatLong } from "@/lib/nim";
import { REFINE_SYSTEM } from "@/lib/prompts";
import { DraftSchema } from "@/lib/essay-types";
import { buildDocx, countWords } from "@/lib/docx-build";
import { validateDraft, assertDraftUsable, pruneOrphanFootnotes, expandFootnoteUses, rebuildWorksCited } from "@/lib/validate";
import { liveSearch, normalizeUrl, extractPages, buildSources } from "@/lib/search";
import type { SourceItem } from "@/lib/essay-types";
import { saveDocxFile } from "@/lib/docx-store";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  projectId: z.string().min(1),
  versionId: z.string().nullish(),
  instruction: z.string().min(1).max(10000),
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

    await prisma.chatMessage.create({
      data: { projectId: body.projectId, role: "user", content: body.instruction.slice(0, 10000) },
    });

    // Follow-up source power: fetch fresh verified pages for this revision
    // so new claims can be cited instead of invented. URLs already cited in
    // the base essay are skipped. Never fails the revision — worst case the
    // model works from existing footnotes plus common knowledge.
    let citedUrls = new Set<string>();
    let maxFnId = 0;
    try {
      const baseDraft = DraftSchema.parse(JSON.parse(base.essayJson));
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
      const web = await liveSearch(followQueries, 4);
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

    const draft = await completeJson(
      {
        system: REFINE_SYSTEM,
        user: `Instruction sheet:\n${project.instruction}\n\nTopic: ${project.topic}\nWord target: ${project.wordTarget}\n\nCurrent essay JSON:\n${base.essayJson}\n\nUser revision instruction:\n${body.instruction}\n\n${sourceBlock}\n\nReturn the revised essay JSON now.`,
        temperature: 0.6,
        maxTokens: 12000,
        schema: DraftSchema,
        validate: assertDraftUsable,
        thinking: false,
      },
      nimChatLong
    );
    pruneOrphanFootnotes(draft);
    expandFootnoteUses(draft);
    rebuildWorksCited(draft);
    if (draft.footnotes.length === 0) {
      throw new Error("The revision came back without usable citations. Try again.");
    }
    const issues = validateDraft(draft);
    const wordCount = countWords(draft);
    const buffer = await buildDocx(draft);

    const version = base.version + 1;
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
