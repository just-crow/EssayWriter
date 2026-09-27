import { z } from "zod";
import type { EssayDraft } from "./essay-types";
import { completeJson, nimChatLong } from "./nim";
import { citationScopes, groupCitationRuns } from "./citation-runs";
import { normalizeUrl } from "./search";
import { sourcePassages } from "./source-passages";
import {
  assertGrounding,
  expandFootnoteUses,
  normQuote,
  pruneOrphanFootnotes,
  rebuildWorksCited,
  sourcesTextMap,
  splitSentences,
} from "./validate";

const ClaimAuditSchema = z.object({
  paragraph: z.number().int().min(0),
  sentence: z.string().default(""),
  sentenceIndex: z.number().int().min(0).optional(),
  status: z.enum([
    "supported",
    "partially_supported",
    "unsupported",
    "common_knowledge",
    "logical_inference",
    "nonfactual",
  ]),
  supportingSourceIndex: z.number().int().min(0).nullish().transform((value) => value ?? undefined),
  supportingPassageIndexes: z.array(z.number().int().min(0)).default([]),
  supportingUrl: z.string().default(""),
  supportingQuote: z.string().default(""),
  reason: z.string(),
});

const GroundingAuditSchema = z.object({ claims: z.array(ClaimAuditSchema) });

function cleanSentence(text: string): string {
  return text.replace(/\[\^\d+\]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Verify every factual sentence against the sources cited during writing.
 * Rebuild footnote numbering and exact evidence anchors without assigning
 * new sources. Unsupported sentences are removed, then the route checks
 * length and paragraph depth and requests a source-based rewrite if needed.
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
  const citationUrls = new Map(draft.footnotes.map((note) => [note.id, note.url]));
  const paragraphs = [
    ...draft.introduction,
    ...draft.sections.flatMap((section) => section.paragraphs),
    ...draft.conclusion,
  ].map((text, paragraph) => {
    return {
    paragraph,
    sentences: splitSentences(text).map((sentence, sentenceIndex) => ({ sentenceIndex, text: cleanSentence(sentence) })),
    citedSources: citationScopes(text).map(({ sentence, ids }) => ({
      sentence: cleanSentence(sentence),
      urls: ids.map(id => citationUrls.get(id)).filter((url): url is string => Boolean(url)),
    })),

    };
  });
  const usedUrls = new Set(paragraphs.flatMap((paragraph) => paragraph.citedSources.flatMap((sentence) => sentence.urls)).map((url) => normalizeUrl(url || "")));
  const usableSources = sources
    .filter((source) => usedUrls.has(normalizeUrl(source.url)) && normalizeUrl(source.url) && source.content.trim().length > 0)
    .map((source, sourceIndex) => ({
      sourceIndex,
      passages: sourcePassages(source.content).map((text, passageIndex) => ({ passageIndex, text })),
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
    paragraph.sentences.map(({ text: sentence, sentenceIndex }) => ({ paragraph: paragraph.paragraph, sentence, sentenceIndex }))
  );
  const key = (paragraph: number, sentence: string) => `${paragraph}:${cleanSentence(sentence).toLowerCase()}`;


  const auditBatch = (batch: typeof paragraphs) => {
    const batchIds = new Set(batch.map(paragraph => paragraph.paragraph));
    const expectedBatch = expected.filter(item => batchIds.has(item.paragraph));
    const batchUrls = new Set(batch.flatMap(paragraph => paragraph.citedSources.flatMap(sentence => sentence.urls)).map(url => normalizeUrl(url || "")));
    return completeJson(
    {
      system: `You are a strict academic source-grounding auditor. Classify EVERY supplied essay sentence exactly once, using only the supplied sourceText and no outside knowledge. Use "supported" only when a source directly entails the entire material factual claim without adding precision, mechanism, causation, population, date, or statistics absent from the page. Use "partially_supported" if only part is entailed, and "unsupported" if none is. Use "common_knowledge" sparingly for stable elementary facts, "logical_inference" only for analysis that follows from already supported statements, and "nonfactual" for headings, transitions, thesis statements, recommendations, or value judgments. Claims about a study's design, measurement methods, bias, confounders, or findings are factual and must be supported by that cited study. General explanations of why correlation does not establish causation may be logical analysis, but do not exempt claims about specific research. For every supported sentence, verify ONLY the original citedSources URLs for that sentence. Return supportingSourceIndex and supportingPassageIndexes for the numbered passages directly supporting the complete claim. Do not copy or paraphrase evidence quotations. Check every clause and every item in a list against the original cited page. If a topic list contains one extra topic absent from that page, it is partially_supported even if another supplied page mentions that topic. Descriptions of actual events, practices, methods, or results are factual, never mere logical analysis. Clearly labeled recommendations, future plans, and hypothetical scenarios are nonfactual unless they assert established facts or proven outcomes. If a proposal embeds factual background, that background still requires direct support. A writer's clearly evaluative comment about why a supported finding is relevant to the essay, or how the essay is organized, is nonfactual or logical_inference and does not require the page to discuss this essay. However, mechanisms, causal explanations, comparisons, and structural details remain external factual claims even when presented as analysis. A heading, title, table label, or generic call for more research is not evidence for a detailed claim. Do not add citations to uncited factual sentences or search other pages for a replacement citation. For supported claims, return the supplied supportingSourceIndex and at least one supportingPassageIndexes entry. For other statuses omit supportingSourceIndex and use an empty supportingPassageIndexes array. Identify each sentence by paragraph and sentenceIndex. Do not merge or split the supplied sentences. Return raw JSON only.`,
      user: `SOURCES:\n${JSON.stringify(usableSources.filter(source => batchUrls.has(normalizeUrl(source.url))).map(({ sourceIndex, title, publisher, url, passages }) => ({ sourceIndex, title, publisher, url, passages })))}\n\nESSAY PARAGRAPHS AND SENTENCES:\n${JSON.stringify(batch)}\n\nReturn {"claims":[{"paragraph":0,"sentenceIndex":0,"status":"supported|partially_supported|unsupported|common_knowledge|logical_inference|nonfactual","supportingSourceIndex":0,"supportingPassageIndexes":[0],"reason":"brief source-specific reason"}]}. Include one entry for every supplied sentenceIndex, with no omissions or additions.`,
      temperature: 0.1,
      thinking: true,
      lowEffort: true,
      reasoningBudget: 1024,
      maxTokens: Math.max(6000, expectedBatch.length * 250 + 1500),
      tries: 2,
      parseTries: 2,
      retryTempDelta: 0,
      schema: GroundingAuditSchema,
      // Indexes avoid reproducing the essay or quotations in the audit.
      responseFormat: { type: "json_object" },
      validate: (value) => {
        // Stable sentence indexes avoid copying/merging text changing audit identity.
        const originalClaims = [...value.claims];
        const missing = expectedBatch.filter(item => !originalClaims.some(candidate => candidate.paragraph === item.paragraph && (
          candidate.sentenceIndex === item.sentenceIndex ||
          (candidate.sentenceIndex === undefined && key(candidate.paragraph, candidate.sentence) === key(item.paragraph, item.sentence))
        )));
        if (missing.length) throw new Error(`The audit omitted sentence indexes ${JSON.stringify(missing.map(({ paragraph, sentenceIndex }) => ({ paragraph, sentenceIndex })))}. Verify every supplied sentence. Missing audit entries are not evidence that these sentences are unsupported. Keep the original paragraph and sentence indexes.`);
        value.claims = expectedBatch.map((item) => {
          const claim = originalClaims.find((candidate) => candidate.paragraph === item.paragraph && (
            candidate.sentenceIndex === item.sentenceIndex ||
            (candidate.sentenceIndex === undefined && key(candidate.paragraph, candidate.sentence) === key(item.paragraph, item.sentence))
          ));
          return claim ? { ...claim, sentence: item.sentence, sentenceIndex: item.sentenceIndex } : {
            paragraph: item.paragraph, sentenceIndex: item.sentenceIndex, sentence: item.sentence,
            status: "unsupported" as const, supportingUrl: "", supportingQuote: "", supportingPassageIndexes: [],
            reason: "The audit omitted this sentence, so its support is unverified.",
          };
        });
        for (const claim of value.claims) {
          // These assert external research or causal effects even when mixed
          // into a proposal. They cannot escape verification as "analysis".
          const explicitProposal = /\b(?:I propose|we propose|recommend|should|could|would)\b/i.test(claim.sentence);
          const researchAssertion = /\b(?:research (?:indicates|shows|demonstrates|links|suggests)|studies (?:show|indicate|demonstrate)|have been shown|has been shown|empirical studies|based on .*research|as supported by .*research|legal (?:and ethical )?requirement)\b/i.test(claim.sentence);
          const benefitAssertion = /\b(?:(?:improve|increase|reduce|enhance|boost)[sd]? (?:outcomes?|results?|performance|rates?|risk|efficiency|quality)|(?:help[s]?|enables|promotes))\b/i.test(claim.sentence);
          const factualAssertion = researchAssertion || (benefitAssertion && (!explicitProposal || /\b(?:because|proven|known to|already)\b/i.test(claim.sentence)));
          if (factualAssertion && claim.status !== "supported" && claim.status !== "partially_supported" && claim.status !== "unsupported") {
            claim.status = "unsupported";
            claim.reason += " This contains a factual research or effectiveness assertion that needs direct cited support.";
          }
          if (claim.status !== "supported") continue;
          const source = claim.supportingSourceIndex !== undefined
            ? usableSources[claim.supportingSourceIndex]
            : sourceByNormalizedUrl.get(normalizeUrl(claim.supportingUrl));
          if (source && claim.supportingSourceIndex !== undefined) {
            claim.supportingUrl = source.url;
            const passages = claim.supportingPassageIndexes.map((index) => source.passages[index]?.text);
            claim.supportingQuote = passages.length > 0 && passages.every(Boolean) ? passages[0]! : "";
          }
          const cited = paragraphs[claim.paragraph]?.citedSources[claim.sentenceIndex!];
          const quote = normQuote(claim.supportingQuote);
          if (!source || !cited?.urls.some((url) => normalizeUrl(url || "") === normalizeUrl(claim.supportingUrl)) || quote.length < 20 || !normQuote(source.sourceText).includes(quote)) {
            claim.status = "unsupported";
            claim.reason += " The original citation has no verifiable supporting passage.";
            claim.supportingUrl = "";
            claim.supportingQuote = "";
          }

        }
      },
    },
    nimChatLong
  );
  };
  const batches = Array.from({ length: Math.ceil(paragraphs.length / 2) }, (_, index) => paragraphs.slice(index * 2, index * 2 + 2));
  const claims: z.output<typeof GroundingAuditSchema>["claims"] = [];
  let nextBatch = 0;
  const worker = async () => {
    while (nextBatch < batches.length) {
      const result = await auditBatch(batches[nextBatch++]);
      claims.push(...result.claims);
    }
  };
  const workers = await Promise.allSettled([worker(), worker()]);
  const failed = workers.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  const audit = { claims };

  const bad = audit.claims.filter((claim) => claim.status === "unsupported" || claim.status === "partially_supported");
  const removed = bad.map((claim) => `paragraph ${claim.paragraph}: ${claim.status} — “${claim.sentence}” (${claim.reason})`);

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
    const bySentence = new Map(claims.map((claim) => [claim.sentenceIndex, claim]));
    const rebuilt = paragraph.sentences.map(({ text: sentence, sentenceIndex }) => {
      const claim = bySentence.get(sentenceIndex);
      if (!claim) return sentence;
      if (claim.status === "unsupported" || claim.status === "partially_supported") return "";
      if (claim.status !== "supported") return sentence;
      const normalizedUrl = normalizeUrl(claim.supportingUrl);
      const selected = sourceItemByUrl.get(normalizedUrl);
      if (!selected || !sourceByUrl.has(normalizedUrl)) {
        throw new Error("The audit selected a source outside the original citations.");
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
      const passages = claim.supportingSourceIndex !== undefined
        ? claim.supportingPassageIndexes.map((index) => usableSources[claim.supportingSourceIndex!].passages[index].text)
        : [claim.supportingQuote];
      for (const quote of passages) newEvidence.push({ paragraph: paragraph.paragraph, source: id, quote });
      return `${sentence}[^${id}]`;
    }).filter(Boolean).join(" ");
    rebuiltParagraphs.push(rebuilt);
  }

  const textMap = sourcesTextMap(sources);

  draft.footnotes = newFootnotes;
  draft.evidence = newEvidence;
  let index = 0;
  draft.introduction = draft.introduction.map(() => rebuiltParagraphs[index++]);
  for (const section of draft.sections) section.paragraphs = section.paragraphs.map(() => rebuiltParagraphs[index++]);
  draft.conclusion = draft.conclusion.map(() => rebuiltParagraphs[index++]);
  if (newFootnotes.length === 0) throw new Error(`No factual claims were supported by their original citations. Rewrite directly from the supplied source text. Rejected claims:\n${removed.slice(0, 8).join("\n")}`);
  pruneOrphanFootnotes(draft);
  expandFootnoteUses(draft);
  rebuildWorksCited(draft);
  groupCitationRuns(draft);
  assertGrounding(draft, textMap);
  return { removed };
}
