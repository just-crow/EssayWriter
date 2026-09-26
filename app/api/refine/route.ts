import { NextResponse } from "next/server";
import { z } from "zod";
import { completeJson, nimChatLong } from "@/lib/nim";
import { REFINE_SYSTEM } from "@/lib/prompts";
import { DraftSchema } from "@/lib/essay-types";
import { buildDocx, countWords } from "@/lib/docx-build";
import { validateDraft, assertDraftUsable, pruneOrphanFootnotes, expandFootnoteUses } from "@/lib/validate";
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

    const draft = await completeJson(
      {
        system: REFINE_SYSTEM,
        user: `Instruction sheet:\n${project.instruction}\n\nTopic: ${project.topic}\nWord target: ${project.wordTarget}\n\nCurrent essay JSON:\n${base.essayJson}\n\nUser revision instruction:\n${body.instruction}\n\nReturn the revised essay JSON now.`,
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
    if (draft.footnotes.length === 0) {
      throw new Error("The revision came back without usable citations. Try again.");
    }
    const issues = validateDraft(draft);
    const wordCount = countWords(draft);
    const buffer = await buildDocx(draft);

    const version = base.version + 1;
    const rel = await saveDocxFile(body.projectId, version, buffer);

    const summary = `Revision v${version}: ${body.instruction.slice(0, 140)} (${wordCount} words, ${draft.footnotes.length} footnotes).`;
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
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Refine failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
