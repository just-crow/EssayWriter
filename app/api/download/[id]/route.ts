import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { DraftSchema } from "@/lib/essay-types";
import { buildDocx } from "@/lib/docx-build";
import { pruneOrphanFootnotes, expandFootnoteUses } from "@/lib/validate";

export const runtime = "nodejs";

function serve(bytes: Uint8Array, title: string, version: number): NextResponse {
  return new NextResponse(new Blob([bytes as BlobPart]), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
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

  // Rebuild from the stored essay JSON so every download carries current
  // builder fixes (e.g. unique footnotes per citation, which old stored
  // files lack). Falls back to the stored file if rebuilding fails.
  try {
    const draft = DraftSchema.parse(JSON.parse(record.essayJson));
    pruneOrphanFootnotes(draft);
    expandFootnoteUses(draft);
    if (draft.footnotes.length > 0) {
      const buf = await buildDocx(draft);
      return serve(new Uint8Array(buf), record.title, record.version);
    }
  } catch {
    // fall through to the stored file
  }

  const abs = path.join(/*turbopackIgnore: true*/ process.cwd(), record.docxPath);
  try {
    const buf = await fs.readFile(abs);
    return serve(new Uint8Array(buf), record.title, record.version);
  } catch {
    return NextResponse.json({ error: "File missing on disk." }, { status: 410 });
  }
}
