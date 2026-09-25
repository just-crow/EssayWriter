import mammoth from "mammoth";
import { extractText } from "unpdf";
import { transcribeImage } from "./vision";

export type ContextItemKind = "text" | "image";

export interface ContextItem {
  filename: string;
  kind: ContextItemKind;
  text: string;
  pages: number;
  mime?: string;
}

const IMAGE_MIMES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export function kindForFilename(name: string): ContextItemKind | null {
  const lower = name.toLowerCase();
  if (/\.(txt|md|docx|pdf)$/.test(lower)) return "text";
  if (/\.(png|jpe?g|webp|gif)$/.test(lower)) return "image";
  return null;
}

/** Extract readable context text from one uploaded file. */
export async function extractContextItem(file: File): Promise<ContextItem> {
  const name = file.name.toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());
  const kind = kindForFilename(file.name);

  if (kind === "image") {
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new Error(
        `${file.name} is ${(buf.length / 1048576).toFixed(1)} MB. Images must be under 6 MB.`
      );
    }
    const ext = "." + (name.split(".").pop() ?? "");
    const text = await transcribeImage(buf, IMAGE_MIMES[ext] ?? "image/png", file.name);
    return { filename: file.name, kind: "image", text, pages: 1 };
  }

  if (name.endsWith(".txt") || name.endsWith(".md")) {
    return { filename: file.name, kind: "text", text: buf.toString("utf-8").slice(0, 60000), pages: 1 };
  }
  if (name.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer: buf });
    return { filename: file.name, kind: "text", text: (result.value || "").slice(0, 60000), pages: 1 };
  }
  if (name.endsWith(".pdf")) {
    const { text, totalPages } = await extractText(buf, { mergePages: false });
    const joined = Array.isArray(text) ? text.join("\n\n") : String(text ?? "");
    return { filename: file.name, kind: "text", text: joined.slice(0, 60000), pages: totalPages ?? 1 };
  }
  if (name.endsWith(".doc")) {
    throw new Error(
      "Legacy .doc is not supported. Re-save as .docx and upload again."
    );
  }
  throw new Error(
    `Unsupported file type: ${file.name}. Use .docx, .pdf, .txt, .md, or an image (.png, .jpg, .webp, .gif).`
  );
}

export async function extractInstructionText(
  file: File
): Promise<{ text: string; pages: number }> {
  const item = await extractContextItem(file);
  return { text: item.text, pages: item.pages };
}
