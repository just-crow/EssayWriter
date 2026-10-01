import type { EssayDraft } from "./essay-types";
import { normQuote, splitSentences } from "./validate";

/**
 * Universal revision-intent parsing. A revision message mixes two things:
 * directives (what to do) and pasted prose (material to place). The model
 * must never confuse them: pasted user wording is authoritative content,
 * never instructions to paraphrase. Nothing here is tied to any particular
 * revision scenario — detection is purely structural (quotes, fences,
 * trailing prose blocks) and vocabulary is generic editing language.
 */

export interface RefineIntent {
  /** What to do, with pasted prose removed. */
  directives: string;
  /** User-supplied prose to place verbatim ("" when none detected). */
  pasted: string;
}

const RESEARCH_VERBS =
  /\b(add|research|find|look\s*up|search|investigat\w*|cite new|new (?:facts|evidence|studies|sources|research)|support .* claims?|expand|update|latest|recent studies)\b/i;
const EDIT_VERBS =
  /\b(replace|insert|swap|use this|shorten|fix|rephrase|reword|restructure|reorder|tone|grammar|spelling|proofread|keep|preserve|stay consistent|verbatim|as written|place)\b/i;

const PASTE_INTRO_MARKERS =
  /here(?:'s| is)|below|following|as follows|my (?:text|version|words|paragraph)|the text|replacement/i;

/** Split a fenced code block, quoted span, or trailing prose block out of a
 * revision message. Returns the message unchanged when no pasted material
 * is detected (safe default: everything is a directive). */
export function splitPastedMaterial(instruction: string): RefineIntent {
  const text = (instruction || "").trim();
  if (!text) return { directives: "", pasted: "" };

  // 1. Fenced blocks are unambiguous pasted material.
  const fence = text.match(/```[\s\S]*?```/);
  if (fence && fence[0].replace(/```/g, "").trim().split(/\s+/).length >= 10) {
    const pasted = fence[0].replace(/```/g, "").trim();
    return { directives: text.replace(fence[0], " ").replace(/\s{2,}/g, " ").trim(), pasted };
  }

  // 2. Long quoted spans ("..." / "...").
  const quote = text.match(/[""][^"""]{40,}[""]|"([^"]{40,})"/);
  if (quote) {
    const pasted = (quote[1] ?? quote[0]).replace(/^[""]|[""]$/g, "").trim();
    if (pasted.split(/\s+/).length >= 10) {
      return { directives: text.replace(quote[0], " ").replace(/\s{2,}/g, " ").trim(), pasted };
    }
  }

  // 3. Trailing prose after a colon: "...stay consistent: <essay prose>".
  // The tail must read as prose on its own (long + multi-sentence), and the
  // head must read as a placement/edit directive — otherwise an ordinary
  // "Note: <long explanation>" message would mis-split. Scan right to left
  // so colons inside the pasted prose itself don't steal the split.
  const PASTE_HEAD = new RegExp(
    `${EDIT_VERBS.source}|here(?:'s| is)|below|my (?:text|version|words|paragraph)|use this|pasted|verbatim`,
    "i"
  );
  const colons: number[] = [];
  for (let i = text.indexOf(":"); i >= 0; i = text.indexOf(":", i + 1)) colons.push(i);
  for (const colonAt of colons.reverse()) {
    const head = text.slice(0, colonAt).trim();
    const tail = text.slice(colonAt + 1).trim();
    if (!head) continue;
    const words = tail.split(/\s+/).filter(Boolean).length;
    if (words >= 40 && splitSentences(tail).length >= 3 && PASTE_HEAD.test(head)) {
      return { directives: head, pasted: tail };
    }
  }

  // 4. A long tail introduced as supplied material ("here is my version ...").
  // Same prose thresholds; the marker only selects the split point.
  const lines = text.split(/\n+/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (PASTE_INTRO_MARKERS.test(lines[i])) {
      const tail = lines.slice(i + 1).join("\n").trim();
      if (tail.split(/\s+/).filter(Boolean).length >= 40 && splitSentences(tail).length >= 3) {
        return { directives: lines.slice(0, i + 1).join("\n").trim(), pasted: tail };
      }
    }
  }

  return { directives: text, pasted: "" };
}

/** Decide whether a revision needs freshly fetched sources. Pure
 * replacement, shortening, restructuring, or proofreading of supplied or
 * existing material does not; anything that may need new external facts
 * does. Uncertain cases fetch (the status quo ante). */
export function needsNewSources(directives: string, hasVerbatimMaterial: boolean): boolean {
  const text = (directives || "").trim();
  if (!text) return hasVerbatimMaterial ? false : true;
  if (RESEARCH_VERBS.test(text)) return true;
  if (hasVerbatimMaterial && (EDIT_VERBS.test(text) || text.length < 140)) return false;
  if (!hasVerbatimMaterial && EDIT_VERBS.test(text) && text.length < 140) return false;
  return true;
}

/** Normalize an explicit target field ("Introduction" from the UI dropdown,
 * "conclusion", a heading) to the lowercase form placeVerbatim matches. */
export function normalizeVerbatimTarget(raw: string): string {
  const t = (raw || "").trim();
  if (/^introduction$/i.test(t)) return "introduction";
  if (/^conclusion$/i.test(t)) return "conclusion";
  return t;
}

/** Resolve a placement target ("introduction", a section heading, ...) to a
 * label the route can act on. Returns null when nothing matches — the model
 * then places the text where the directives indicate. */
export function resolveVerbatimTarget(
  target: string,
  directives: string,
  headings: string[]
): string | null {
  const want = (target || "").trim().toLowerCase();
  const dirs = `${target} ${directives}`.toLowerCase();
  if (/\bintro|opening|beginning|first (part|paragraph|section)\b/.test(dirs) && !want) return "introduction";
  if (want === "introduction" || want === "conclusion") return want;
  if (want) {
    const hit = headings.find((h) => h.toLowerCase().includes(want) || want.includes(h.toLowerCase()));
    if (hit) return hit;
  }
  if (/\bconclu|closing|final (paragraph|section)|the end\b/.test(dirs) && !want) return "conclusion";
  for (const h of headings) {
    if (h && dirs.includes(h.toLowerCase())) return h;
  }
  return null;
}

/** Split pasted prose into paragraphs (blank lines win; otherwise group
 * sentences so no paragraph is a one-liner). */
export function splitVerbatimParagraphs(text: string): string[] {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length > 1) return blocks;
  const sentences = splitSentences(text.trim()).filter((s) => /[a-z0-9]/i.test(s));
  const out: string[] = [];
  for (let i = 0; i < sentences.length; i += 4) out.push(sentences.slice(i, i + 4).join(" "));
  return out.filter(Boolean);
}

export interface VerbatimPlacement {
  applied: boolean;
  targetLabel: string;
  /** Which part was replaced (for exempting user-owned prose from shape minimums). */
  part: "introduction" | "conclusion" | "section" | null;
  sectionIndex: number | null;
  /** Section heading at placement time (re-located by heading after rewrite). */
  heading: string | null;
}

/** Mechanically place user text at the resolved target. Never touches model
 * wording: the writer pass afterwards only reconciles citations and flow
 * around it. */
export function placeVerbatim(
  draft: { introduction: string[]; sections: Array<{ heading: string; paragraphs: string[] }>; conclusion: string[] },
  target: string | null,
  text: string
): VerbatimPlacement {
  const paragraphs = splitVerbatimParagraphs(text);
  const none: VerbatimPlacement = { applied: false, targetLabel: "", part: null, sectionIndex: null, heading: null };
  if (paragraphs.length === 0) return none;
  if (target === "introduction") {
    draft.introduction = paragraphs;
    return { applied: true, targetLabel: "the introduction", part: "introduction", sectionIndex: null, heading: null };
  }
  if (target === "conclusion") {
    draft.conclusion = paragraphs;
    return { applied: true, targetLabel: "the conclusion", part: "conclusion", sectionIndex: null, heading: null };
  }
  if (target) {
    const sectionIndex = draft.sections.findIndex((s) => s.heading === target);
    if (sectionIndex >= 0) {
      draft.sections[sectionIndex].paragraphs = paragraphs;
      return { applied: true, targetLabel: `the section “${target}”`, part: "section", sectionIndex, heading: target };
    }
  }
  return none;
}

/** Normalized sentences of user-supplied material, markers stripped (the
 * server renumbers footnotes legitimately). The audit exempts these from
 * deletion (kept as the author's own wording); verification still applies
 * to their citations. */
export function userSentenceSet(text: string): Set<string> {
  return new Set(
    splitSentences(text)
      .map((s) => normQuote(s.replace(/\[\^\d+\]/g, "").trim()))
      .filter((s) => s.length >= 12)
  );
}

/** Check that user-supplied sentences survived the model rewrite verbatim.
 * Returns normalized sentences that went missing (excluding pure citation
 * markers, which the server renumbers legitimately). */
export function missingVerbatim(outputText: string, userSentences: Set<string>): string[] {
  const present = new Set(
    splitSentences(outputText).map((s) => normQuote(s.replace(/\[\^\d+\]/g, "").trim()))
  );
  return [...userSentences].filter(
    (s) => !present.has(s) && !present.has(normQuote(s.replace(/\[\^\d+\]/g, "").trim()))
  );
}

/** Drop footnote markers with no matching footnote entry instead of failing
 * the whole revision (pasted text may reference old numbering). Mutates. */
export function dropDanglingMarkers(
  draft: Pick<EssayDraft, "introduction" | "sections" | "conclusion" | "footnotes">
): void {
  const valid = new Set(draft.footnotes.map((f) => f.id));
  if (valid.size === 0) return;
  const clean = (text: string) =>
    text.replace(/\[\^(\d+)\]/g, (marker, id: string) => (valid.has(Number(id)) ? marker : ""));
  draft.introduction = draft.introduction.map(clean);
  for (const section of draft.sections) section.paragraphs = section.paragraphs.map(clean);
  draft.conclusion = draft.conclusion.map(clean);
}

/** Truncate at a word boundary so summaries never end mid-word. */
export function cutAtWord(text: string, max: number): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max).replace(/\s+\S*$/, "");
  return cut || t.slice(0, max);
}
