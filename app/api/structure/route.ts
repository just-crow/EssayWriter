import { NextResponse } from "next/server";
import { z } from "zod";
import { completeJson } from "@/lib/nim";
import { STRUCTURE_SYSTEM, structureUserPrompt } from "@/lib/prompts";
import { StructureSchema } from "@/lib/essay-types";
import { assertStructureUsable } from "@/lib/validate";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 120;

const Body = z.object({
  topic: z.string().min(1).max(500),
  instructionText: z.string().max(60000).default(""),
  extraInstructions: z.string().max(20000).default(""),
  wordTarget: z.number().int().min(200).max(10000).default(1200),
  projectId: z.string().nullish(),
});

export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    const structure = await completeJson({
      system: STRUCTURE_SYSTEM,
      user: structureUserPrompt(body),
      temperature: 0.5,
      maxTokens: 4000,
      schema: StructureSchema,
      validate: assertStructureUsable,
    });

    let projectId = body.projectId;
    if (projectId) {
      await prisma.project.update({
        where: { id: projectId },
        data: {
          topic: body.topic,
          instruction: body.instructionText.slice(0, 20000),
          wordTarget: body.wordTarget,
        },
      });
    } else {
      const project = await prisma.project.create({
        data: {
          title: body.topic.slice(0, 120),
          topic: body.topic,
          instruction: body.instructionText.slice(0, 20000),
          wordTarget: body.wordTarget,
        },
      });
      projectId = project.id;
    }

    return NextResponse.json({ projectId, structure });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Structure failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
