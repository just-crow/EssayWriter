import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import { completeJson, nimChatLong } from "@/lib/nim";
import { DRAFT_SYSTEM, draftUserPrompt } from "@/lib/prompts";
import { DraftSchema } from "@/lib/essay-types";
import { buildDocx, countWords } from "@/lib/docx-build";
import { validateDraft, assertDraftUsable } from "@/lib/validate";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  topic: z.string().min(1).max(500),
  instructionText: z.string().max(60000).default(""),
  extraInstructions: z.string().max(20000).default(""),
  wordTarget: z.number().int().min(200).max(10000).default(1200),
  structureJson: z.string().min(2).max(30000),
  sourcesJson: z.string().min(2).max(60000),
  projectId: z.string().nullish(),
});

async function saveDocx(projectId: string, version: number, buf: Buffer): Promise<string> {
  const dir = path.join(process.cwd(), "storage");
  await fs.mkdir(dir, { recursive: true });
  const rel = path.join("storage", `${projectId}-v${version}.docx`);
  await fs.writeFile(path.join(process.cwd(), rel), buf);
  return rel;
}

export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    const draft = await completeJson(
      {
        system: DRAFT_SYSTEM,
        user: draftUserPrompt(body),
        temperature: 0.6,
        maxTokens: 12000,
        schema: DraftSchema,
        validate: assertDraftUsable,
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

    const existing = await prisma.essayVersion.count({ where: { projectId } });
    const version = existing + 1;
    const docxPath = await saveDocx(projectId, version, buffer);
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
