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
  "No", "Fig", "fig", "al", "Dept", "Univ", "Rep", "Sen", "Gov", "Prof", "U.S", "U.K", "U.N", "Ph.D",
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
    const re = new RegExp(`\\b${ab.replace(/\./g, "\\.")}\\.`, "g");
    // Replace EVERY dot inside the match ("e.g" keeps an interior dot),
    // so no abbreviation fragment can ever split a sentence.
    t = t.replace(re, () => `${ab.split(".").join(PH)}${PH}`);
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

/** Reject source-sentence recycling used to meet the word target. */
export function assertNoRepeatedSentences(draft: EssayDraft): void {
  const sentences = [...draft.introduction, ...draft.sections.flatMap((section) => section.paragraphs), ...draft.conclusion]
    .flatMap(splitSentences).map((sentence) => sentence.replace(/\[\^\d+\]/g, "").replace(/\s+/g, " ").trim().toLowerCase())
    .filter((sentence) => sentence.split(/\s+/).length >= 12);
  if (sentences.length - new Set(sentences).size > 1) {
    throw new Error("The essay repeats substantial sentences across paragraphs. Paraphrase the evidence and develop each finding once, with distinct analysis and explicit recommendations. Do not pad the word count by repeating source sentences.");
  }
}

export function cleanRawQuote(s: string): string {
  if (!s) return "";
  return s
    .replace(/!\[.*?\](?:\([^\)]*\))?/g, "")
    .replace(/\[([^\]]+)\](?:\([^\)]*\))?/g, "$1")
    .replace(/\]\([a-zA-Z0-9_+.~#?&=/%:-\s]*/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[—–]/g, "-")
    .replace(/(\.{3}|…)$/, "")
    .replace(/^["'`“”‘’\s]+|["'`“”‘’\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalize for quote matching: case, whitespace, curly quotes, and the
 * HTML entities extractors commonly leave behind (&amp; vs &). */
export function normQuote(s: string): string {
  return cleanRawQuote(s)
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, "-")
    .replace(/(\.{3}|…)$/, "")
    .replace(/^["'`“”‘’\s]+|["'`“”‘’\s]+$/g, "")
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

/**
 * Remove unverified or out-of-bounds evidence items from a draft.
 * Returns the count of pruned items.
 */
export function pruneUnverifiedEvidence(
  draft: EssayDraft,
  sourcesText: Map<string, string>
): number {
  if (!draft.evidence || draft.evidence.length === 0) return 0;
  const byId = new Map(draft.footnotes.map((f) => [f.id, f]));
  const count = bodyParagraphCount(draft);
  const initialLen = draft.evidence.length;
  draft.evidence = draft.evidence.filter((e) => {
    if (e.paragraph >= count) return false;
    const fn = byId.get(e.source);
    if (!fn) return false;
    const text = sourcesText.get(normalizeUrl(fn.url || "")) ?? "";
    if (!text) return false;
    const cleaned = cleanRawQuote(e.quote || "");
    const quote = normQuote(cleaned);
    if (quote.length < 12) return false;
    if (normQuote(text).includes(quote)) {
      e.quote = cleaned;
      return true;
    }
    const cand = findCandidateInText(text, cleaned);
    if (cand) {
      e.quote = cand;
      return true;
    }
    return false;
  });
  return initialLen - draft.evidence.length;
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

export function findCandidateInText(srcText: string, rawQuote: string): string | null {
  if (!srcText) return null;
  const cleanQuote = cleanRawQuote(rawQuote);
  if (cleanQuote.length < 12) return null;

  const normT = normQuote(srcText);
  const candidates = srcText
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[-*#>\s]+/, "").trim())
    .filter((s) => s.length >= 12 && s.length <= 700);

  // 1. Direct clean quote match
  if (normT.includes(normQuote(cleanQuote))) {
    const match = candidates.find((s) => normQuote(s).includes(normQuote(cleanQuote)));
    if (match) return match;
  }

  // 2. Subsentence after period (e.g. "health. Delaying..." -> "Delaying...")
  const subSentence = cleanQuote.replace(/^.+?[.!?]\s+/, "").trim();
  if (subSentence.length >= 12 && normT.includes(normQuote(subSentence))) {
    const match = candidates.find((s) => normQuote(s).includes(normQuote(subSentence)));
    if (match) return match;
  }

  // 3. Truncated tail (strip last word or two)
  const prefix = cleanQuote.replace(/\s+\S+(?:\s+\S+)?$/, "").trim();
  if (prefix.length >= 12 && normT.includes(normQuote(prefix))) {
    const match = candidates.find((s) => normQuote(s).includes(normQuote(prefix)));
    if (match) return match;
  }

  // 4. Subsentence without tail
  const subPrefix = subSentence.replace(/\s+\S+(?:\s+\S+)?$/, "").trim();
  if (subPrefix.length >= 12 && normT.includes(normQuote(subPrefix))) {
    const match = candidates.find((s) => normQuote(s).includes(normQuote(subPrefix)));
    if (match) return match;
  }

  // 5. Clean markdown link syntax: [Text](url) -> Text
  const strippedQuote = cleanQuote.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_#`]/g, "").trim();
  if (strippedQuote !== cleanQuote && strippedQuote.length >= 12 && normT.includes(normQuote(strippedQuote))) {
    const match = candidates.find((s) => normQuote(s).includes(normQuote(strippedQuote)));
    if (match) return match;
  }

  return null;
}

/** Replace a close paraphrase in an evidence record with the nearest exact
 * source sentence. Searches the assigned source first, and if ungrounded,
 * checks all other gathered sources for a verifiable match. */
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
    if (text && normQuote(text).includes(normQuote(item.quote || ""))) continue;

    // Check candidate within assigned source text first
    const directCandidate = findCandidateInText(text, item.quote || "");
    if (directCandidate) {
      item.quote = directCandidate;
      repaired++;
      continue;
    }

    const wanted = wordSet(`${item.quote} ${paragraphs[item.paragraph] || ""}`);
    if (wanted.size < 3) continue;

    const evaluate = (srcText: string) => {
      const candidates = srcText
        .split(/(?<=[.!?])\s+|\n+/)
        .map((s) => s.replace(/^[-*#>\s]+/, "").trim())
        .filter((s) => s.length >= 12 && s.length <= 700);
      const sourceWords = srcText.split(/\s+/).filter(Boolean);
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
        if (overlap >= 1 && score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
      return { best, score: bestScore };
    };

    let result = text ? evaluate(text) : { best: "", score: 0 };

    // If assigned source has no candidate with score >= 0.1, check across other sources
    if ((!result.best || result.score < 0.1) && sourcesText.size > 0) {
      const assignedNorm = normalizeUrl(source?.url || "");
      let bestOtherUrl = "";
      for (const [otherUrl, otherText] of sourcesText.entries()) {
        if (!otherText || otherUrl === assignedNorm) continue;
        const crossCandidate = findCandidateInText(otherText, item.quote || "");
        if (crossCandidate) {
          result = { best: crossCandidate, score: 1.0 };
          bestOtherUrl = otherUrl;
          break;
        }
        const otherRes = evaluate(otherText);
        if (otherRes.score > result.score && otherRes.score >= 0.05) {
          result = otherRes;
          bestOtherUrl = otherUrl;
        }
      }
      if (bestOtherUrl && result.best) {
        const existingFn = footnotes.find((f) => normalizeUrl(f.url || "") === bestOtherUrl);
        if (existingFn) {
          const oldSourceId = item.source;
          item.source = existingFn.id;
          if (paragraphs[item.paragraph]) {
            paragraphs[item.paragraph] = paragraphs[item.paragraph].replace(
              new RegExp(`\\[\\^${oldSourceId}\\]`, "g"),
              `[^${existingFn.id}]`
            );
          }
        } else if (source) {
          source.url = bestOtherUrl;
        }
      }
    }

    if (result.best && result.score >= 0.05) {
      item.quote = result.best;
      repaired++;
    }
  }
  return repaired;
}

export function consolidateSectionParagraphs(draft: EssayDraft): void {
  // 1. Normalize introduction and conclusion to exactly 1 paragraph each
  const introOldCount = draft.introduction.length;
  if (draft.introduction.length > 1) {
    draft.introduction = [draft.introduction.filter(Boolean).join(" ")];
  }
  const conclusionOldCount = draft.conclusion.length;
  if (draft.conclusion.length > 1) {
    draft.conclusion = [draft.conclusion.filter(Boolean).join(" ")];
  }

  // 2. Track original paragraph indexes
  const oldFlat: Array<{ type: "intro" | "sec" | "conclusion"; si?: number; pi?: number; oldIdx: number }> = [];
  let flatIdx = 0;
  for (let pi = 0; pi < introOldCount; pi++) {
    oldFlat.push({ type: "intro", pi, oldIdx: flatIdx++ });
  }
  for (let si = 0; si < draft.sections.length; si++) {
    for (let pi = 0; pi < draft.sections[si].paragraphs.length; pi++) {
      oldFlat.push({ type: "sec", si, pi, oldIdx: flatIdx++ });
    }
  }
  for (let pi = 0; pi < conclusionOldCount; pi++) {
    oldFlat.push({ type: "conclusion", pi, oldIdx: flatIdx++ });
  }

  const oldToNew = new Map<number, number>();
  for (let pi = 0; pi < introOldCount; pi++) {
    oldToNew.set(pi, 0);
  }

  const cleanWords = (text: string) => text.replace(/\[\^\d+\]/g, "").split(/\s+/).filter(Boolean).length;
  const sentenceCount = (text: string) => splitSentences(text).length;

  let newFlatIdx = 1;
  for (let si = 0; si < draft.sections.length; si++) {
    const sec = draft.sections[si];
    if (sec.paragraphs.length === 0) continue;
    const consolidated: string[] = [];
    let current = "";
    let currentOldIndices: number[] = [];

    for (let pi = 0; pi < sec.paragraphs.length; pi++) {
      const p = sec.paragraphs[pi].trim();
      if (!p) continue;
      const oldItem = oldFlat.find((o) => o.type === "sec" && o.si === si && o.pi === pi);
      const oldIdx = oldItem ? oldItem.oldIdx : null;

      if (!current) {
        current = p;
        if (oldIdx !== null) currentOldIndices.push(oldIdx);
        continue;
      }

      const words = cleanWords(current);
      const sentences = sentenceCount(current);

      if (words < 80 || sentences < 3) {
        current += ` ${p}`;
        if (oldIdx !== null) currentOldIndices.push(oldIdx);
      } else {
        consolidated.push(current);
        for (const idx of currentOldIndices) oldToNew.set(idx, newFlatIdx);
        newFlatIdx++;
        current = p;
        currentOldIndices = oldIdx !== null ? [oldIdx] : [];
      }
    }

    if (current) {
      const words = cleanWords(current);
      const sentences = sentenceCount(current);
      if ((words < 60 || sentences < 3) && consolidated.length > 0) {
        consolidated[consolidated.length - 1] += ` ${current}`;
        for (const idx of currentOldIndices) oldToNew.set(idx, newFlatIdx - 1);
      } else {
        consolidated.push(current);
        for (const idx of currentOldIndices) oldToNew.set(idx, newFlatIdx);
        newFlatIdx++;
      }
    }
    sec.paragraphs = consolidated;
  }

  // 3. Check for any remaining shallow section paragraphs across sections
  for (let si = 0; si < draft.sections.length; si++) {
    const sec = draft.sections[si];
    for (let pi = sec.paragraphs.length - 1; pi >= 0; pi--) {
      const p = sec.paragraphs[pi];
      if (cleanWords(p) < 60 || sentenceCount(p) < 3) {
        if (pi > 0) {
          sec.paragraphs[pi - 1] += ` ${p}`;
          sec.paragraphs.splice(pi, 1);
        } else if (si > 0 && draft.sections[si - 1].paragraphs.length > 0) {
          const prev = draft.sections[si - 1];
          prev.paragraphs[prev.paragraphs.length - 1] += ` ${p}`;
          sec.paragraphs.splice(pi, 1);
        } else if (si + 1 < draft.sections.length && draft.sections[si + 1].paragraphs.length > 0) {
          const next = draft.sections[si + 1];
          next.paragraphs[0] = `${p} ${next.paragraphs[0]}`;
          sec.paragraphs.splice(pi, 1);
        }
      }
    }
  }

  // Remove empty sections
  draft.sections = draft.sections.filter((s) => s.paragraphs.length > 0);

  // Recalculate conclusion index
  const finalSectionCount = draft.sections.flatMap((s) => s.paragraphs).length;
  const conclusionNewIdx = 1 + finalSectionCount;
  for (const cItem of oldFlat.filter((o) => o.type === "conclusion")) {
    oldToNew.set(cItem.oldIdx, conclusionNewIdx);
  }

  // Remap evidence paragraph indexes and clamp
  if (draft.evidence) {
    const finalParagraphs = [...draft.introduction, ...draft.sections.flatMap((s) => s.paragraphs), ...draft.conclusion];
    const totalParas = 1 + finalSectionCount + draft.conclusion.length;
    for (const e of draft.evidence) {
      // Each audited citation occurrence has a unique footnote ID. Use its
      // final location after cross-section merges, rather than a stale index.
      const citedParagraph = finalParagraphs.findIndex((text) => text.includes(`[^${e.source}]`));
      if (citedParagraph >= 0) {
        e.paragraph = citedParagraph;
        continue;
      }
      if (oldToNew.has(e.paragraph)) {
        e.paragraph = oldToNew.get(e.paragraph)!;
      }
      if (e.paragraph >= totalParas) {
        e.paragraph = Math.max(0, totalParas - 1);
      }
    }
  }
}

/** Run citation repair inside completeJson's validation/retry boundary.
 * Restore omitted markers only from evidence already checked against its
 * actual source text. Never assign an arbitrary bibliography entry. */
export function prepareDraft(draft: EssayDraft, sourcesText: Map<string, string>, options: { deferEvidence?: boolean } = {}): void {
  assertDraftUsable(draft);
  const ids = draft.footnotes.map((f) => f.id);
  if (new Set(ids).size !== ids.length) throw new Error("The essay has duplicate footnote IDs. Give each source a distinct ID.");
  normalizeMarkerFormat(draft);
  const paragraphs = [...draft.introduction, ...draft.sections.flatMap((s) => s.paragraphs), ...draft.conclusion];
  // 1-based paragraph indexing recovery for evidence
  if (
    draft.evidence &&
    draft.evidence.length > 0 &&
    !draft.evidence.some((e) => e.paragraph === 0) &&
    draft.evidence.some((e) => e.paragraph >= paragraphs.length)
  ) {
    for (const e of draft.evidence) e.paragraph -= 1;
  }
  // Clamp single off-by-one boundary (e.g. conclusion index)
  if (draft.evidence && paragraphs.length > 0) {
    for (const e of draft.evidence) {
      if (e.paragraph === paragraphs.length) {
        e.paragraph = paragraphs.length - 1;
      }
    }
  }
  const defined = new Set(ids);
  for (const text of paragraphs) {
    for (const match of text.matchAll(/\[\^(\d+)\]/g)) {
      if (!defined.has(Number(match[1]))) throw new Error(`Citation [^${match[1]}] has no footnote. Supply its source or remove the unsupported claim.`);
    }
  }
  // The semantic audit verifies each claim against its original citation.
  // Do not fabricate quote anchors or change sources before that check.
  if (options.deferEvidence) return;
  const byId = new Map(draft.footnotes.map((f) => [f.id, f]));
  const grounded = new Set(draft.evidence.map((item) => item.paragraph));
  const missing = paragraphs.map((_text, paragraph) => paragraph).filter((paragraph) => !grounded.has(paragraph));
  for (const paragraph of missing) {
    const marker = paragraphs[paragraph].match(/\[\^(\d+)\]/);
    const source = marker ? Number(marker[1]) : 0;
    if (!source || !defined.has(source)) continue;
    const fn = byId.get(source);
    const text = sourcesText.get(normalizeUrl(fn?.url || "")) || "";
    if (!text) continue;
    const wanted = wordSet(paragraphs[paragraph]);
    if (wanted.size < 3) continue;
    const candidates = text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.replace(/^[-*#>\s]+/, "").trim())
      .filter((s) => s.length >= 12 && s.length <= 700);
    let best = "";
    let bestScore = 0;
    for (const candidate of candidates) {
      const words = wordSet(candidate);
      const overlap = [...wanted].filter((w) => words.has(w)).length;
      const score = overlap / Math.max(1, Math.min(wanted.size, words.size));
      if (overlap >= 2 && score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (best && bestScore >= 0.1) {
      draft.evidence.push({ paragraph, source, quote: best });
    }
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

  // A citation should have an anchor. Analysis and labeled proposals may
  // have no external factual claim and therefore no citation to anchor.
  {
    const introLen = draft.introduction.length;
    const paragraphs = draft.sections.flatMap((s) => s.paragraphs);
    const withEv = new Set((draft.evidence ?? []).map((e) => e.paragraph));
    let bare = 0;
    for (let i = 0; i < paragraphs.length; i++) {
      if (/\[\^\d+\]/.test(paragraphs[i]) && !withEv.has(introLen + i)) bare++;
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
