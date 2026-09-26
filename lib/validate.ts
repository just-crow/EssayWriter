import type { EssayDraft, EssayStructure } from "./essay-types";
import { normalizeUrl } from "./search";

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

/** Minimum average words per body paragraph. Below this the essay is a
 * checklist of one-liners, not developed writing. */
export const MIN_AVG_PARAGRAPH_WORDS = 40;

/** Minimum share of body sentences carrying a footnote marker. Below this
 * the essay states too much without citing. Common-knowledge and transition
 * sentences legitimately lack markers, hence well under 1. */
export const MIN_CITED_SENTENCE_SHARE = 0.5;

/** Abbreviations whose periods must not split sentences. */
const ABBREVIATIONS = [
  "e.g", "i.e", "etc", "Dr", "Mr", "Mrs", "Ms", "St", "vs", "approx",
  "No", "Fig", "fig", "al", "Dept", "Univ", "Rep", "Sen", "Gov", "Prof",
];

/** Split text into sentences without breaking on common abbreviations.
 * Footnote markers stay attached to their sentence: "end.[^1] Next" splits
 * into ["end.[^1]", "Next"] so cited sentences are counted on their own.
 * (Placeholder is a unicode escape in source so no editor encoding can
 * mangle it into a real punctuation mark.) */
export function splitSentences(text: string): string[] {
  const PH = "";
  let t = ` ${text} `;
  for (const ab of ABBREVIATIONS) {
    const re = new RegExp(`\\b${ab}\\.`, "g");
    // Replace EVERY dot inside the match ("e.g" keeps an interior dot),
    // so no abbreviation fragment can ever split a sentence.
    t = t.replace(re, () => ab.split(".").join(PH));
  }
  const out: string[] = [];
  const re = /[^.!?]+(?:[.!?]+(?:\s*\[\^\d+\])*)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const s = m[0].split(PH).join(".").trim();
    if (s.length > 0) out.push(s);
  }
  return out;
}

/** Share of body (sections) sentences carrying at least one [^n] marker. */
export function citedSentenceShare(draft: EssayDraft): { share: number; cited: number; total: number } {
  const sentences = draft.sections.flatMap((s) => s.paragraphs.flatMap(splitSentences));
  const total = sentences.length;
  if (total === 0) return { share: 0, cited: 0, total: 0 };
  const cited = sentences.filter((s) => /\[\^\d+\]/.test(s)).length;
  return { share: cited / total, cited, total };
}

/** Normalize for quote matching: case, whitespace, and curly quotes. */
function normQuote(s: string): string {
  return s
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export interface EvidenceItem {
  paragraph: number;
  source: number;
  quote: string;
}

/**
 * Verify every evidence quote is a verbatim span of its source's text.
 * `sourcesText` maps normalized URL -> full page text (or snippet fallback).
 * Returns human-readable failures (empty = all verified). Pure function.
 */
export function verifyEvidence(
  evidence: EvidenceItem[],
  footnotes: Array<{ id: number; url?: string }>,
  sourcesText: Map<string, string>
): string[] {
  const failures: string[] = [];
  const byId = new Map(footnotes.map((f) => [f.id, f]));
  for (const e of evidence) {
    const fn = byId.get(e.source);
    if (!fn) {
      failures.push(`evidence cites unknown footnote ${e.source}`);
      continue;
    }
    const text = sourcesText.get(normalizeUrl(fn.url || "")) ?? "";
    const quote = normQuote(e.quote || "");
    if (quote.length < 12) {
      failures.push(`evidence for source ${e.source} is too short to verify`);
      continue;
    }
    if (!text || !normQuote(text).includes(quote)) {
      failures.push(
        `quote for source ${e.source} not found in its page text: “${e.quote.slice(0, 80)}...”`
      );
    }
  }
  return failures;
}

/** Body-paragraph indexes present in the draft (intro + sections + conclusion). */
export function bodyParagraphCount(draft: EssayDraft): number {
  return draft.introduction.length + draft.sections.flatMap((s) => s.paragraphs).length + draft.conclusion.length;
}

/** Normalize paragraph text for byte-identical comparison. */
export function normPara(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Build a lookup of normalized source URL -> page text for verification. */
export function sourcesTextMap(items: Array<{ url?: string; content?: string }>): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of items) {
    const k = normalizeUrl(s.url || "");
    if (k && !m.has(k)) m.set(k, s.content || "");
  }
  return m;
}

export interface GroundingOpts {
  /** Minimum cited-sentence share (default MIN_CITED_SENTENCE_SHARE). */
  minShare?: number;
  /** Base essay's share: refined text must not regress below min(threshold, base). */
  baseShare?: number;
  /** In refine, paragraphs with no marker above this id carry no new claims. */
  newOnlyAfterId?: number;
  /** Normalized base paragraphs (refine): byte-identical ones need no new evidence. */
  baseParagraphs?: Set<string>;
  /** Draft-only: cap on section-paragraph count. Forces merging into
   * developed paragraphs instead of spraying one-liners. */
  maxBodyParas?: number;
  /** Base essay's average body-paragraph length (refine): refined text must
   * not regress below min(MIN_AVG_PARAGRAPH_WORDS, base). */
  baseAvg?: number;
}

/** Average words per section (body) paragraph. */
export function avgBodyParaWords(draft: EssayDraft): number {
  const paras = draft.sections.flatMap((s) => s.paragraphs);
  if (paras.length === 0) return 0;
  const words = paras
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
  return words / paras.length;
}

/**
 * RAG grounding gate. Throws a retryable, human-readable error when:
 * - cited-sentence share falls below threshold (regressions allowed only
 *   down to the base essay's own share, never below the floor), or
 * - a body paragraph that makes new claims lacks verifiable evidence, or
 * - any evidence quote isn't a verbatim span of its source's text.
 */
export function assertGrounding(
  draft: EssayDraft,
  sourcesText: Map<string, string>,
  opts?: GroundingOpts
): void {
  const minShare = opts?.minShare ?? MIN_CITED_SENTENCE_SHARE;
  const threshold =
    opts?.baseShare !== undefined ? Math.min(minShare, opts.baseShare) : minShare;
  const cov = citedSentenceShare(draft);
  if (cov.total > 0 && cov.share < threshold - 1e-9) {
    throw new Error(
      `Only ${cov.cited}/${cov.total} sentences carry citations (need ${Math.round(threshold * 100)}%). Ground every factual sentence in a source. Try again.`
    );
  }

  const avg = avgBodyParaWords(draft);
  if (avg > 0) {
    const avgFloor =
      opts?.baseAvg !== undefined
        ? Math.min(MIN_AVG_PARAGRAPH_WORDS, opts.baseAvg)
        : MIN_AVG_PARAGRAPH_WORDS;
    if (avg < avgFloor - 1e-9) {
      throw new Error(
        `Body paragraphs average ${Math.round(avg)} words (need ${Math.round(avgFloor)}). Develop each paragraph fully instead of one-liners. Try again.`
      );
    }
  }

  const bodyCount = draft.sections.flatMap((s) => s.paragraphs).length;
  if (opts?.maxBodyParas !== undefined && bodyCount > opts.maxBodyParas) {
    throw new Error(
      `Too many thin body paragraphs (${bodyCount}, need ${opts.maxBodyParas} or fewer). Merge related points into full developed paragraphs. Try again.`
    );
  }

  const introLen = draft.introduction.length;
  const secBlocks = draft.sections.flatMap((s) => s.paragraphs);
  const evByPara = new Map<number, EvidenceItem[]>();
  for (const e of draft.evidence ?? []) {
    if (!evByPara.has(e.paragraph)) evByPara.set(e.paragraph, []);
    evByPara.get(e.paragraph)!.push(e);
  }
  const missing: number[] = [];
  secBlocks.forEach((para, i) => {
    const gi = introLen + i;
    if (opts?.baseParagraphs?.has(normPara(para))) return; // untouched old text
    if (opts?.newOnlyAfterId !== undefined) {
      const ids = [...para.matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1]));
      if (ids.length > 0 && ids.every((id) => id <= (opts.newOnlyAfterId as number))) return;
      if (ids.length === 0) return; // no claims needing new evidence
    }
    const items = evByPara.get(gi) ?? [];
    if (items.length === 0) missing.push(gi);
  });
  if (missing.length > 0) {
    throw new Error(
      `Paragraphs missing verifiable evidence (indexes ${missing.slice(0, 6).join(", ")}). ` +
        `Anchor each body paragraph with a verbatim quote from its source. Try again.`
    );
  }

  const fails = verifyEvidence(draft.evidence ?? [], draft.footnotes, sourcesText);
  if (fails.length > 0) {
    throw new Error(`Unverifiable evidence — ${fails.slice(0, 2).join(" ")} Try again.`);
  }
}

/** Reject placeholder-empty drafts (all-default schemas would accept them).
 * Throws a friendly, retryable error.
 * Note: em dash / semicolon leftovers do NOT fail here on purpose. The
 * prompt tells the model to avoid them and validateDraft still flags them
 * in the UI, but a stray one must never discard a whole essay.
 * Depth and grounding are enforced by assertGrounding (routes call it
 * right after this), never by rejection here. */
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
