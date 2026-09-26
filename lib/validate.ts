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
  // Decimal points are not sentence boundaries (for example, 76.5%).
  t = t.replace(/(\d)\.(?=\d)/g, `$1${PH}`);
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

/** Share of body (sections) sentences carrying at least one [^n] marker.
 * Informational only — never a pass/fail gate, since common-knowledge and
 * transition sentences legitimately lack markers. */
export function citedSentenceShare(draft: EssayDraft): { share: number; cited: number; total: number } {
  const sentences = draft.sections.flatMap((s) => s.paragraphs.flatMap(splitSentences));
  const total = sentences.length;
  if (total === 0) return { share: 0, cited: 0, total: 0 };
  const cited = sentences.filter((s) => /\[\^\d+\]/.test(s)).length;
  return { share: cited / total, cited, total };
}

/** Normalize for quote matching: case, whitespace, curly quotes, and the
 * HTML entities extractors commonly leave behind (&amp; vs &). */
function normQuote(s: string): string {
  return s
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
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
    if (!k) continue;
    const existing = m.get(k) || "";
    const content = s.content || "";
    // Preserve text snapshots from older versions when a page is refreshed.
    if (!existing) m.set(k, content);
    else if (content && !existing.includes(content)) m.set(k, `${existing}\n\n${content}`);
  }
  return m;
}

/**
 * RAG grounding gate. Throws a retryable, human-readable error only when
 * an evidence quote isn't a verbatim span of its source's text (fabricated
 * evidence is never acceptable). Missing per-paragraph evidence does NOT
 * fail here — it is reported as a soft warning by validateDraft instead.
 * Deliberately no per-sentence citation ratio and no paragraph shape rules:
 * the model decides bullet counts and paragraph lengths itself.
 */
export function assertGrounding(
  draft: EssayDraft,
  sourcesText: Map<string, string>
): void {
  const fails = verifyEvidence(draft.evidence ?? [], draft.footnotes, sourcesText);
  const count = bodyParagraphCount(draft);
  for (const e of draft.evidence) {
    if (e.paragraph >= count) fails.push(`evidence paragraph ${e.paragraph} does not exist`);
  }
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
    !d.introduction.some((p) => p.trim()) ||
    !d.sections.some((s) => s.paragraphs.some((p) => p.trim())) ||
    !d.conclusion.some((p) => p.trim()) ||
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
 * The model sometimes writes bare [1] markers instead of the required [^1].
 * Rewrite bare bracketed numbers matching a real footnote id even when
 * the model mixes them with correct [^n] markers. Years
 * ([2020]) can't match: ids are 1-3 digits and must exist in footnotes.
 * Returns how many markers were converted. Mutates the draft.
 */
export function normalizeMarkerFormat(draft: EssayDraft): number {
  const ids = new Set(draft.footnotes.map((f) => f.id));
  if (ids.size === 0) return 0;
  let count = 0;
  const rewrite = (t: string): string =>
    t.replace(/\[(\d{1,3})\]/g, (m, n: string) => {
      if (!ids.has(Number(n))) return m;
      count++;
      return `[^${Number(n)}]`;
    });
  draft.introduction = draft.introduction.map(rewrite);
  for (const s of draft.sections) s.paragraphs = s.paragraphs.map(rewrite);
  draft.conclusion = draft.conclusion.map(rewrite);
  return count;
}

const STOP_WORDS = new Set("a an and are as at be been being but by for from had has have he her hers him his i in into is it its of on or our she that the their them they this to was were will with you your".split(" "));

function wordSet(s: string): Set<string> {
  return new Set((normQuote(s).match(/[a-z0-9]+/g) ?? []).filter((word) => word.length > 2 && !STOP_WORDS.has(word)));
}

/** Replace a close paraphrase in an evidence record with the nearest exact
 * source sentence. This never crosses sources and requires substantial word
 * overlap, so unrelated or invented evidence still fails assertGrounding. */
export function repairEvidenceQuotes(
  evidence: EvidenceItem[],
  footnotes: Array<{ id: number; url?: string }>,
  sourcesText: Map<string, string>,
  paragraphs: string[] = []
): number {
  const byId = new Map(footnotes.map((f) => [f.id, f]));
  let repaired = 0;
  for (const item of evidence) {
    const source = byId.get(item.source);
    const text = sourcesText.get(normalizeUrl(source?.url || "")) || "";
    if (!text || normQuote(text).includes(normQuote(item.quote || ""))) continue;
    const wanted = wordSet(`${item.quote} ${paragraphs[item.paragraph] || ""}`);
    if (wanted.size < 5) continue;
    const candidates = text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.replace(/^[-*#>\s]+/, "").trim())
      .filter((s) => s.length >= 12 && s.length <= 700);
    // Some extracted pages are one long punctuation-free snippet. Add
    // overlapping verbatim windows so those sources remain repairable.
    const sourceWords = text.split(/\s+/).filter(Boolean);
    for (let start = 0; start < sourceWords.length; start += 30) {
      const window = sourceWords.slice(start, start + 60).join(" ").trim();
      if (window.length >= 12) candidates.push(window);
    }
    let best = "";
    let bestScore = 0;
    for (const candidate of candidates) {
      const words = wordSet(candidate);
      const overlap = [...wanted].filter((word) => words.has(word)).length;
      const score = overlap / Math.max(1, Math.min(wanted.size, words.size));
      if (overlap >= 2 && score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (best && bestScore >= 0.1) {
      item.quote = best;
      repaired++;
    }
  }
  return repaired;
}

/** Run citation repair inside completeJson's validation/retry boundary.
 * Restore omitted markers only from evidence already checked against its
 * actual source text. Never assign an arbitrary bibliography entry. */
export function prepareDraft(draft: EssayDraft, sourcesText: Map<string, string>): void {
  assertDraftUsable(draft);
  const ids = draft.footnotes.map((f) => f.id);
  if (new Set(ids).size !== ids.length) throw new Error("The essay has duplicate footnote IDs. Give each source a distinct ID.");
  normalizeMarkerFormat(draft);
  const paragraphs = [...draft.introduction, ...draft.sections.flatMap((s) => s.paragraphs), ...draft.conclusion];
  const defined = new Set(ids);
  for (const text of paragraphs) {
    for (const match of text.matchAll(/\[\^(\d+)\]/g)) {
      if (!defined.has(Number(match[1]))) throw new Error(`Citation [^${match[1]}] has no footnote. Supply its source or remove the unsupported claim.`);
    }
  }
  const grounded = new Set(draft.evidence.map((item) => item.paragraph));
  const missing = paragraphs.map((_text, paragraph) => paragraph).filter((paragraph) => !grounded.has(paragraph));
  for (const paragraph of missing) {
    const marker = paragraphs[paragraph].match(/\[\^(\d+)\]/);
    const source = marker ? Number(marker[1]) : 0;
    if (!source || !defined.has(source)) {
      continue;
    }
    // The exact quote is selected from this same source below. The semantic
    // audit later decides whether that source actually entails the claim.
    draft.evidence.push({ paragraph, source, quote: paragraphs[paragraph].replace(/\[\^\d+\]/g, "") });
  }
  repairEvidenceQuotes(draft.evidence, draft.footnotes, sourcesText, paragraphs);
  assertGrounding(draft, sourcesText);
  for (const e of draft.evidence) {
    const marker = `[^${e.source}]`;
    if (!paragraphs[e.paragraph].includes(marker)) paragraphs[e.paragraph] += marker;
  }
  let index = 0;
  draft.introduction = draft.introduction.map(() => paragraphs[index++]);
  for (const section of draft.sections) section.paragraphs = section.paragraphs.map(() => paragraphs[index++]);
  draft.conclusion = draft.conclusion.map(() => paragraphs[index++]);
  pruneOrphanFootnotes(draft);
  if (draft.footnotes.length === 0) {
    throw new Error("The essay has no usable in-text citations. Add [^n] markers matching the footnotes for supported claims.");
  }
  expandFootnoteUses(draft);
  rebuildWorksCited(draft);
  assertGrounding(draft, sourcesText);
}

/**
 * Drop footnote entries never cited in the text (and their Works Cited
 * lines), then renumber the rest sequentially. Dangling markers with no
 * footnote entry are removed from the text. Only deletes tokens, never
 * prose. Returns the dropped footnote ids.
 */
export function pruneOrphanFootnotes(draft: EssayDraft): number[] {
  // First rescue the alternate marker format, if that's all there is.
  normalizeMarkerFormat(draft);
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
  draft.evidence = draft.evidence
    .filter((e) => idMap.has(e.source))
    .map((e) => ({ ...e, source: idMap.get(e.source)! }));
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
  const uses = new Map<string, number>();
  let paragraph = 0;
  const rewrite = (t: string): string => {
    const current = paragraph++;
    return t.replace(/\[\^(\d+)\]/g, (_m, n: string) => {
      const src = byId.get(Number(n));
      if (!src) return "";
      expanded.push({ ...src, id: expanded.length + 1 });
      const key = `${current}:${Number(n)}`;
      if (!uses.has(key)) uses.set(key, expanded.length);
      return `[^${expanded.length}]`;
    });
  };
  draft.introduction = draft.introduction.map(rewrite);
  for (const s of draft.sections) s.paragraphs = s.paragraphs.map(rewrite);
  draft.conclusion = draft.conclusion.map(rewrite);
  draft.footnotes = expanded;
  draft.evidence = draft.evidence
    .filter((e) => uses.has(`${e.paragraph}:${e.source}`))
    .map((e) => ({ ...e, source: uses.get(`${e.paragraph}:${e.source}`)! }));
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

  // Soft visibility (never blocking): body paragraphs without an anchored
  // quote rely on markers/common knowledge alone.
  {
    const introLen = draft.introduction.length;
    const secCount = draft.sections.flatMap((s) => s.paragraphs).length;
    const withEv = new Set((draft.evidence ?? []).map((e) => e.paragraph));
    let bare = 0;
    for (let i = 0; i < secCount; i++) {
      if (!withEv.has(introLen + i)) bare++;
    }
    if (bare > 0) {
      issues.push({
        code: "EVIDENCE_MISSING",
        detail: `${bare} body paragraph${bare === 1 ? "" : "s"} ha${bare === 1 ? "s" : "ve"} no anchored source quote — sourcing there rests on markers alone.`,
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
