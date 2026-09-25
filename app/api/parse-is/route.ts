import { NextResponse } from "next/server";
import { extractContextItem, type ContextItem } from "@/lib/is-extract";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_FILES = 5;
const MAX_FILE_BYTES = 12 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    // Accept "files" (multi) or legacy single "file".
    const raw = [...form.getAll("files"), form.get("file")].filter(
      (v): v is File => v instanceof File && v.size > 0
    );
    if (raw.length === 0) {
      return NextResponse.json({ error: "No files uploaded." }, { status: 400 });
    }
    if (raw.length > MAX_FILES) {
      return NextResponse.json(
        { error: `Too many files (max ${MAX_FILES} per upload).` },
        { status: 400 }
      );
    }

    const items: ContextItem[] = [];
    const errors: Array<{ filename: string; error: string }> = [];
    for (const file of raw) {
      if (file.size > MAX_FILE_BYTES) {
        errors.push({ filename: file.name, error: "File too large (max 12 MB)." });
        continue;
      }
      try {
        items.push(await extractContextItem(file));
      } catch (err) {
        errors.push({
          filename: file.name,
          error: err instanceof Error ? err.message : "Read failed.",
        });
      }
    }

    if (items.length === 0) {
      return NextResponse.json(
        { error: errors[0]?.error ?? "Could not read those files.", errors },
        { status: 400 }
      );
    }

    const combinedText = items
      .map((it) =>
        items.length > 1 || it.kind === "image"
          ? `--- From ${it.filename} ---\n${it.text}`
          : it.text
      )
      .join("\n\n");

    return NextResponse.json({
      combinedText,
      items: items.map((it) => ({
        filename: it.filename,
        kind: it.kind,
        text: it.text,
        pages: it.pages,
      })),
      errors,
      // legacy single-file fields
      text: combinedText,
      pages: items.reduce((n, it) => n + it.pages, 0),
      filename: items.length === 1 ? items[0].filename : `${items.length} files`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Parse failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
