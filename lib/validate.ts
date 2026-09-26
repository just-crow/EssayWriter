import type { EssayDraft, EssayStructure } from "./essay-types";

/** All checkable draft text in one place (body, headings, bibliography,
 * footnote contents). */
function draftText(d: EssayDraft): string {
  return [
    d.title,
    ...d.introduction,
    ...d.sections.flatMap((s) => [s.heading, ...s.paragraphs]),
    ...d.conclusion,
    ...d.worksCited,
    ...d.footnotes.map((f) =>
      [f.author, f.title, f.publisher, f.year, f.url, f.accessed].join(" ")
    ),
  ].join("\n");
}

/** Reject placeholder-empty drafts (all-default schemas would accept them).
 * Throws a friendly, retryable error.
 * Note: em dash / semicolon leftovers do NOT fail here on purpose. The
 * prompt tells the model to avoid them and validateDraft still flags them
 * in the UI, but a stray one must never discard a whole essay. */
export function assertDraftUsable(d: EssayDraft): void {
  if (
    !d.title ||
    d.title === "Untitled Essay" ||
    d.introduction.length === 0 ||
    d.sections.length === 0 ||
    d.footnotes.length === 0
  ) {
    throw new Error("The model returned an empty essay. Try again.");
  }
}

/** Reject placeholder-empty outlines for the same reason. */
export function assertStructureUsable(s: EssayStructure): void {
  if (!s.thesis || s.sections.length === 0) {
    throw new Error("The model returned an empty outline. Try again.");
  }
}

export type ValidationIssue = { code: string; detail: string };

/**
 * Drop footnote entries never cited in the text (and their Works Cited
 * lines), then renumber the rest sequentially. Dangling markers with no
 * footnote entry are removed from the text. Only deletes tokens, never
 * prose. Returns the dropped footnote ids.
 */
export function pruneOrphanFootnotes(draft: EssayDraft): number[] {
  const defined = new Set(draft.footnotes.map((f) => f.id));
  const bodyText = [
    ...draft.introduction,
    ...draft.sections.flatMap((s) => s.paragraphs),
    ...draft.conclusion,
  ].join("\n");
  const order: number[] = [];
  for (const m of bodyText.matchAll(/\[\^(\d+)\]/g)) {
    const id = Number(m[1]);
    if (defined.has(id) && !order.includes(id)) order.push(id);
  }
  const idMap = new Map(order.map((oldId, i) => [oldId, i + 1]));
  const dropped = draft.footnotes.map((f) => f.id).filter((id) => !idMap.has(id));
  const rewrite = (t: string): string =>
    t.replace(/\[\^(\d+)\]/g, (_m, n: string) => {
      const next = idMap.get(Number(n));
      return next === undefined ? "" : `[^${next}]`;
    });
  draft.introduction = draft.introduction.map(rewrite);
  for (const s of draft.sections) s.paragraphs = s.paragraphs.map(rewrite);
  draft.conclusion = draft.conclusion.map(rewrite);
  const droppedUrls = new Set(
    draft.footnotes
      .filter((f) => !idMap.has(f.id))
      .map((f) => f.url)
      .filter((u) => u && u.length >= 24)
  );
  draft.footnotes = draft.footnotes
    .filter((f) => idMap.has(f.id))
    .map((f) => ({ ...f, id: idMap.get(f.id) as number }))
    .sort((a, b) => a.id - b.id);
  if (droppedUrls.size > 0) {
    draft.worksCited = draft.worksCited.filter(
      (w) => ![...droppedUrls].some((u) => w.includes(u as string))
    );
  }
  return dropped;
}

/**
 * Word requires every in-text footnote reference to point at a UNIQUE
 * footnote definition: citing one source twice with a single shared id
 * makes Word report the file as corrupted (verified against real Word).
 * So each [^n] occurrence gets its own sequential footnote entry with
 * cloned text — exactly the "repeat the full citation on every use" rule.
 * Dangling markers with no footnote entry are removed. Mutates the draft.
 */
export function expandFootnoteUses(draft: EssayDraft): void {
  const byId = new Map(draft.footnotes.map((f) => [f.id, f]));
  const expanded: EssayDraft["footnotes"] = [];
  const rewrite = (t: string): string =>
    t.replace(/\[\^(\d+)\]/g, (_m, n: string) => {
      const src = byId.get(Number(n));
      if (!src) return "";
      expanded.push({ ...src, id: expanded.length + 1 });
      return `[^${expanded.length}]`;
    });
  draft.introduction = draft.introduction.map(rewrite);
  for (const s of draft.sections) s.paragraphs = s.paragraphs.map(rewrite);
  draft.conclusion = draft.conclusion.map(rewrite);
  draft.footnotes = expanded;
}

/**
 * Rebuild Works Cited deterministically from the footnote entries:
 * dedupe by URL, format one MLA-ish line per source, sort alphabetically.
 * The model sometimes returns empty strings here; deriving from footnotes
 * (which are verified present) guarantees a non-empty, consistent list.
 * Mutates the draft.
 */
export function rebuildWorksCited(draft: EssayDraft): void {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const f of draft.footnotes) {
    const key = (f.url || "").trim().toLowerCase() || `${f.author}|${f.title}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const head = f.author
      ? `${f.author}. “${f.title}.”`
      : f.title
        ? `“${f.title}.”`
        : "Untitled.";
    const pub = [f.publisher, f.year].filter(Boolean).join(", ");
    entries.push(
      `${head}${pub ? ` ${pub}.` : ""}${f.url ? ` ${f.url}.` : ""}${f.accessed ? ` Accessed ${f.accessed}.` : ""}`
    );
  }
  entries.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  draft.worksCited = entries;
}

export function validateDraft(draft: EssayDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allText = draftText(draft);

  if (allText.includes("—")) {
    issues.push({
      code: "EM_DASH",
      detail: "Em dash character found. Rewrite with commas, periods, colons, or parentheses.",
    });
  }
  if (allText.includes(";")) {
    issues.push({
      code: "SEMICOLON",
      detail: "Semicolon character found. Rewrite with commas, periods, colons, or parentheses.",
    });
  }

  const footnoteIds = new Set(draft.footnotes.map((f) => f.id));
  const markerRe = /\[\^(\d+)\]/g;
  const bodyText = [
    ...draft.introduction,
    ...draft.sections.flatMap((s) => s.paragraphs),
    ...draft.conclusion,
  ].join("\n");
  let m: RegExpExecArray | null;
  const used = new Set<number>();
  while ((m = markerRe.exec(bodyText)) !== null) {
    used.add(Number(m[1]));
    if (!footnoteIds.has(Number(m[1]))) {
      issues.push({
        code: "FOOTNOTE_MISSING",
        detail: `Marker [^${m[1]}] has no matching footnote entry.`,
      });
    }
  }

  for (const fn of draft.footnotes) {
    if (!used.has(fn.id)) {
      issues.push({
        code: "FOOTNOTE_ORPHAN",
        detail: `Footnote ${fn.id} is never cited in the text — its marker is missing.`,
      });
    }
  }

  for (const fn of draft.footnotes) {
    if (!fn.url) {
      issues.push({ code: "FOOTNOTE_NO_LINK", detail: `Footnote ${fn.id} has no URL.` });
    } else if (fn.url.includes("archive.org")) {
      issues.push({
        code: "FOOTNOTE_ARCHIVE",
        detail: `Footnote ${fn.id} uses archive.org. Replace with publisher, Google Books, JSTOR, or university page.`,
      });
    }
    if (!fn.accessed) {
      issues.push({
        code: "FOOTNOTE_NO_DATE",
        detail: `Footnote ${fn.id} has no access date.`,
      });
    }
  }

  for (const entry of draft.worksCited) {
    if (entry.includes("archive.org")) {
      issues.push({
        code: "BIB_ARCHIVE",
        detail: "A Works Cited entry uses archive.org. Replace it.",
      });
    }
    if (!/Accessed/i.test(entry)) {
      issues.push({
        code: "BIB_NO_DATE",
        detail: `Works Cited entry missing access date: ${entry.slice(0, 80)}...`,
      });
    }
  }

  return issues;
}

export async function checkLinksLive(urls: string[]): Promise<string[]> {
  const dead: string[] = [];
  for (const url of urls.slice(0, 40)) {
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "follow" });
      if (!res.ok) dead.push(url);
    } catch {
      dead.push(url);
    }
  }
  return dead;
}
