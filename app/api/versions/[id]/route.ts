import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/** Full essay JSON for one version (powers history preview + footnotes). */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const record = await prisma.essayVersion.findUnique({ where: { id } });
  if (!record) return NextResponse.json({ error: "Not found." }, { status: 404 });
  let draft: unknown = null;
  try {
    draft = JSON.parse(record.essayJson);
  } catch {
    draft = null;
  }
  return NextResponse.json({
    id: record.id,
    version: record.version,
    title: record.title,
    draft,
    wordCount: record.wordCount,
    footnoteCount: record.footnoteCount,
    summary: record.summary,
    downloadUrl: `/api/download/${record.id}`,
  });
}
