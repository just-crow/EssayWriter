import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { prisma } from "@/lib/db";
import { DraftSchema } from "@/lib/essay-types";
import { buildDocx } from "@/lib/docx-build";
import { pruneOrphanFootnotes, expandFootnoteUses, rebuildWorksCited } from "@/lib/validate";

export const runtime = "nodejs";

function serve(bytes: Uint8Array, title: string, version: number): NextResponse {
  return new NextResponse(new Blob([bytes as BlobPart]), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${title || "essay"}-v${version}.docx"`,
      "Content-Length": String(bytes.length),
    },
  });
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const record = await prisma.essayVersion.findUnique({ where: { id } });
  if (!record) return NextResponse.json({ error: "Not found." }, { status: 404 });

  // Primary path: rebuild from the stored essay JSON. This is what makes
  // downloads work on serverless (no durable disk) and applies current
  // builder fixes to old versions automatically.
  try {
    const draft = DraftSchema.parse(JSON.parse(record.essayJson));
    pruneOrphanFootnotes(draft);
    expandFootnoteUses(draft);
    rebuildWorksCited(draft);
    if (draft.footnotes.length > 0) {
      const buf = await buildDocx(draft);
      return serve(new Uint8Array(buf), record.title, record.version);
    }
  } catch {
    // fall through to disk cache
  }

  // Fallback: disk cache (local dev tmpdir, then legacy ./storage).
  const candidates = [
    path.join(os.tmpdir(), "essaywriter-storage", path.basename(record.docxPath)),
    path.join(/*turbopackIgnore: true*/ process.cwd(), record.docxPath),
  ];
  for (const abs of candidates) {
    try {
      const buf = await fs.readFile(abs);
      return serve(new Uint8Array(buf), record.title, record.version);
    } catch {
      // try next location
    }
  }
  return NextResponse.json({ error: "File unavailable." }, { status: 410 });
}
