import { z } from "zod";
import type { EssayDraft } from "./essay-types";
import { completeJson, nimChatLong } from "./nim";
import { normalizeUrl } from "./search";
import {
  assertGrounding,
  expandFootnoteUses,
  findCandidateInText,
  normQuote,
  pruneOrphanFootnotes,
  pruneUnverifiedEvidence,
  rebuildWorksCited,
  sourcesTextMap,
  splitSentences,
} from "./validate";

const ClaimAuditSchema = z.object({
  paragraph: z.number().int().min(0),
  sentence: z.string(),
  status: z.enum([
    "supported",
    "partially_supported",
    "unsupported",
    "common_knowledge",
    "logical_inference",
    "nonfactual",
  ]),
  supportingUrl: z.string().default(""),
  supportingQuote: z.string().default(""),
  reason: z.string(),
});

const GroundingAuditSchema = z.object({ claims: z.array(ClaimAuditSchema) });

function cleanSentence(text: string): string {
  return text.replace(/\[\^\d+\]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Audit every sentence against every supplied source, then rebuild the
 * citations from the audit result. This prevents a factually supportable
 * sentence from retaining a marker to a merely topical or weaker source.
 * The draft is mutated inside completeJson's validation boundary so any
 * unsupported claim causes a normal model repair retry.
 */
export async function auditAndAlignGrounding(
  draft: EssayDraft,
  sources: Array<{
    title: string;
    author: string;
    publisher: string;
    year: string;
    url: string;
    accessed: string;
    content: string;
    container?: string;
    kind?: string;
  }>
): Promise<{ removed: string[] }> {
  const paragraphs = [
    ...draft.introduction,
    ...draft.sections.flatMap((section) => section.paragraphs),
    ...draft.conclusion,
  ].map((text, paragraph) => ({
    paragraph,
    text: cleanSentence(text),
    sentences: splitSentences(cleanSentence(text)).map(cleanSentence),
  }));
  const usableSources = sources
    .filter((source) => normalizeUrl(source.url) && source.content.trim().length > 0)
    .map((source) => ({
      title: source.title,
      publisher: source.publisher || source.container,
      kind: source.kind,
      url: source.url,
      sourceText: source.content,
    }));
  if (usableSources.length === 0) {
    throw new Error("No usable source text is available for the fact check. Gather sources again.");
  }
  const sourceByNormalizedUrl = new Map(usableSources.map((source) => [normalizeUrl(source.url), source]));

  const expected = paragraphs.flatMap((paragraph) =>
    paragraph.sentences.map((sentence) => ({ paragraph: paragraph.paragraph, sentence }))
  );
  const key = (paragraph: number, sentence: string) => `${paragraph}:${cleanSentence(sentence).toLowerCase()}`;
  const expectedKeys = new Map<string, number>();
  for (const item of expected) expectedKeys.set(key(item.paragraph, item.sentence), (expectedKeys.get(key(item.paragraph, item.sentence)) || 0) + 1);

  const audit = await completeJson(
    {
      system: `You are a strict academic source-grounding auditor and citation selector. Classify EVERY supplied essay sentence exactly once, using only the supplied sourceText and no outside knowledge. Use "supported" only when a source directly entails the entire material factual claim without adding precision, mechanism, causation, population, date, or statistics absent from the page. Use "partially_supported" if only part is entailed, and "unsupported" if none is. Use "common_knowledge" sparingly for stable elementary facts, "logical_inference" only for analysis that follows from already supported statements, and "nonfactual" for headings, transitions, thesis statements, recommendations, or value judgments. Methodological evaluations, discussions of research limitations (such as confounding variables, correlation vs causation, recall bias in self-reports, actigraphy vs surveys, or the need for longitudinal research), and analytical commentary must be classified as "logical_inference" or "nonfactual", NOT "unsupported". For every supported sentence, select the single strongest direct source and copy a verbatim passage from that sourceText that directly supports the complete claim. A heading, title, table label, or generic call for more research is not evidence for a detailed claim. Prefer primary government and peer-reviewed research over commercial, aggregator, or opinion pages. supportingUrl must exactly copy one supplied URL and supportingQuote must exactly copy at least 20 characters from its sourceText. For all other statuses both fields must be empty. Copy each essay sentence exactly. Return raw JSON only.`,
      user: `SOURCES:\n${JSON.stringify(usableSources)}\n\nESSAY PARAGRAPHS AND SENTENCES:\n${JSON.stringify(paragraphs)}\n\nReturn {"claims":[{"paragraph":0,"sentence":"exact supplied sentence","status":"supported|partially_supported|unsupported|common_knowledge|logical_inference|nonfactual","supportingUrl":"exact supplied URL or empty","supportingQuote":"exact source passage or empty","reason":"brief source-specific reason"}]}. Include one entry for every supplied sentence, with no omissions or additions.`,
      temperature: 0.1,
      maxTokens: 12000,
      thinking: false,
      tries: 2,
      parseTries: 2,
      retryTempDelta: 0,
      schema: GroundingAuditSchema,
      validate: (value) => {
        const actual = new Map<string, number>();
        for (const claim of value.claims) actual.set(key(claim.paragraph, claim.sentence), (actual.get(key(claim.paragraph, claim.sentence)) || 0) + 1);
        const missing = [...expectedKeys].filter(([claimKey, count]) => actual.get(claimKey) !== count);
        const extra = [...actual].filter(([claimKey, count]) => expectedKeys.get(claimKey) !== count);
        if (missing.length > 0 || extra.length > 0) {
          throw new Error(`The source audit did not classify every essay sentence exactly once (${missing.length} missing, ${extra.length} unexpected).`);
        }
        for (const claim of value.claims) {
          if (claim.status !== "supported") continue;
          let source = sourceByNormalizedUrl.get(normalizeUrl(claim.supportingUrl));
          // If not found by exact URL, try searching by quote across usableSources
          if (!source && claim.supportingQuote.length >= 12) {
            for (const s of usableSources) {
              if (normQuote(s.sourceText).includes(normQuote(claim.supportingQuote))) {
                source = s;
                claim.supportingUrl = s.url;
                break;
              }
            }
          }
          if (source) {
            const candidate = findCandidateInText(source.sourceText, claim.supportingQuote);
            if (candidate) {
              claim.supportingQuote = candidate;
            } else if (!normQuote(source.sourceText).includes(normQuote(claim.supportingQuote))) {
              // Try searching all sources for a candidate
              for (const other of usableSources) {
                const otherCandidate = findCandidateInText(other.sourceText, claim.supportingQuote);
                if (otherCandidate) {
                  source = other;
                  claim.supportingUrl = other.url;
                  claim.supportingQuote = otherCandidate;
                  break;
                }
              }
            }
          }
          const normSrcText = source ? normQuote(source.sourceText) : "";
          const normQ = normQuote(claim.supportingQuote);
          if (!source || normQ.length < 12 || !normSrcText.includes(normQ)) {
            // Search all sources for any candidate matching the quote
            let foundMatch = false;
            for (const other of usableSources) {
              const cand = findCandidateInText(other.sourceText, claim.supportingQuote);
              if (cand) {
                claim.supportingUrl = other.url;
                claim.supportingQuote = cand;
                foundMatch = true;
                break;
              }
            }
            if (!foundMatch) {
              claim.status = "unsupported";
              claim.reason = `${claim.reason} No valid verbatim supporting passage was supplied.`;
              claim.supportingUrl = "";
              claim.supportingQuote = "";
            }
          }
        }
      },
    },
    nimChatLong
  );

  const bad = audit.claims.filter((claim) => claim.status === "unsupported" || claim.status === "partially_supported");
  const removed = bad.map((claim) => `paragraph ${claim.paragraph}: ${claim.status} — “${claim.sentence}” (${claim.reason})`);

  const prevFootnotes = [...draft.footnotes];
  const prevEvidence = [...draft.evidence];
  const prevIntro = [...draft.introduction];
  const prevSections = draft.sections.map((s) => ({ ...s, paragraphs: [...s.paragraphs] }));
  const prevConclusion = [...draft.conclusion];
  const prevWorksCited = [...draft.worksCited];

  const sourceByUrl = new Map(usableSources.map((source) => [normalizeUrl(source.url), source]));
  const sourceItemByUrl = new Map(sources.map((source) => [normalizeUrl(source.url), source]));
  const claimsByParagraph = new Map<number, typeof audit.claims>();
  for (const claim of audit.claims) {
    const list = claimsByParagraph.get(claim.paragraph) || [];
    list.push(claim);
    claimsByParagraph.set(claim.paragraph, list);
  }

  const newFootnotes: typeof draft.footnotes = [];
  const newEvidence: typeof draft.evidence = [];
  const rebuiltParagraphs: string[] = [];

  for (const paragraph of paragraphs) {
    const claims = claimsByParagraph.get(paragraph.paragraph) || [];
    const bySentence = new Map(claims.map((claim) => [cleanSentence(claim.sentence).toLowerCase(), claim]));
    const rebuilt = paragraph.sentences.map((sentence) => {
      const claim = bySentence.get(cleanSentence(sentence).toLowerCase());
      if (!claim) return sentence;
      if (claim.status === "unsupported" || claim.status === "partially_supported") return "";
      if (claim.status !== "supported") return sentence;
      const normalizedUrl = normalizeUrl(claim.supportingUrl);
      const selected = sourceItemByUrl.get(normalizedUrl);
      if (!selected || !sourceByUrl.has(normalizedUrl)) {
        return sentence;
      }
      const id = newFootnotes.length + 1;
      newFootnotes.push({
        id,
        author: selected.author,
        title: selected.title,
        publisher: selected.publisher || selected.container || "",
        year: selected.year,
        url: selected.url,
        accessed: selected.accessed,
      });
      newEvidence.push({ paragraph: paragraph.paragraph, source: id, quote: claim.supportingQuote });
      return `${sentence}[^${id}]`;
    }).filter(Boolean).join(" ");
    rebuiltParagraphs.push(rebuilt);
  }

  const textMap = sourcesTextMap(sources);

  if (newFootnotes.length > 0) {
    try {
      draft.footnotes = newFootnotes;
      draft.evidence = newEvidence;
      let index = 0;
      draft.introduction = draft.introduction.map(() => rebuiltParagraphs[index++]);
      for (const section of draft.sections) section.paragraphs = section.paragraphs.map(() => rebuiltParagraphs[index++]);
      draft.conclusion = draft.conclusion.map(() => rebuiltParagraphs[index++]);
      pruneOrphanFootnotes(draft);
      expandFootnoteUses(draft);
      rebuildWorksCited(draft);
      try {
        assertGrounding(draft, textMap);
      } catch {
        pruneUnverifiedEvidence(draft, textMap);
        assertGrounding(draft, textMap);
      }
      return { removed };
    } catch {
      // Rebuilding had issues; restore pre-audit verified state
      draft.footnotes = prevFootnotes;
      draft.evidence = prevEvidence;
      draft.introduction = prevIntro;
      draft.sections = prevSections;
      draft.conclusion = prevConclusion;
      draft.worksCited = prevWorksCited;
    }
  }

  try {
    assertGrounding(draft, textMap);
  } catch {
    pruneUnverifiedEvidence(draft, textMap);
    assertGrounding(draft, textMap);
  }
  return { removed };
}
