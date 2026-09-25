import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const record = await prisma.essayVersion.findUnique({ where: { id } });
  if (!record) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const abs = path.join(/*turbopackIgnore: true*/ process.cwd(), record.docxPath);
  try {
    const buf = await fs.readFile(abs);
    const bytes = new Uint8Array(buf);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${record.title || "essay"}-v${record.version}.docx"`,
        "Content-Length": String(bytes.length),
      },
    });
  } catch {
    return NextResponse.json({ error: "File missing on disk." }, { status: 410 });
  }
}
