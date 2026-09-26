import { promises as fs } from "fs";
import os from "os";
import path from "path";

/**
 * Best-effort docx persistence. Serverless filesystems are read-only
 * except os.tmpdir(), and tmp files are ephemeral across invocations —
 * so a failed write must never fail a request. Downloads rebuild from
 * the database (see the download route), disk is only a convenience cache.
 * Always resolves with a docxPath-shaped string for the DB record.
 */
export async function saveDocxFile(
  projectId: string,
  version: number,
  buf: Buffer
): Promise<string> {
  const rel = path.join("storage", `${projectId}-v${version}.docx`);
  try {
    const dir = path.join(os.tmpdir(), "essaywriter-storage");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${projectId}-v${version}.docx`), buf);
  } catch {
    // ignore: the DB record + rebuild-on-download carry the file
  }
  return rel;
}
