import { z } from "zod";
import type { EssayDraft } from "./essay-types";
import { completeJson, nimChatLong } from "./nim";
import { citationScopes, groupCitationRuns } from "./citation-runs";
import { normalizeUrl } from "./search";
import { sourcePassages, relevantSourcePassages } from "./source-passages";
import { createHash } from "node:crypto";
import {
  assertGrounding,
  expandFootnoteUses,
  normQuote,
  pruneOrphanFootnotes,
  rebuildWorksCited,
  sourcesTextMap,
  splitSentences,
  uncoveredClaimTerms,
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
  onTopic: z.boolean().default(true),
  supportingSourceIndex: z.preprocess((value) => value === -1 ? undefined : value,
    z.number().int().min(0).nullish()).transform((value) => value ?? undefined),
  supportingPassageIndexes: z.array(z.number().int().min(0)).default([]),
  supportingUrl: z.string().default(""),
  supportingQuote: z.string().default(""),
  reason: z.string(),
});

const GroundingAuditSchema = z.object({ claims: z.array(ClaimAuditSchema) });
const completedChecks = new Map<string, {expires: number; value: z.output<typeof GroundingAuditSchema>}>();

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
  }>,
  options: { signal?: AbortSignal; batchSize?: number; fast?: boolean; topic?: string } = {}
): Promise<{ removed: string[] }> {
  const citationUrls = new Map(draft.footnotes.map((note) => [note.id, note.url]));
  const paragraphs = [
    ...draft.introduction,
    ...draft.sections.flatMap((section) => section.paragraphs),
    ...draft.conclusion,
  ].map((text, paragraph) => {
    const bodyIndex = paragraph - draft.introduction.length;
    let position = 0;
    const heading = bodyIndex < 0 ? "Introduction" : draft.sections.find(section => {
      const matched = bodyIndex >= position && bodyIndex < position + section.paragraphs.length;
      position += section.paragraphs.length;
      return matched;
    })?.heading || "Conclusion";
    return {
    paragraph,
    heading,
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

  const key = (paragraph: number, sentence: string) => `${paragraph}:${cleanSentence(sentence).toLowerCase()}`;


  const conclusionStart = draft.introduction.length + draft.sections.flatMap(section => section.paragraphs).length;
  const auditBatchOnce = (batch: typeof paragraphs) => {
    const isConclusion = batch.every(paragraph => paragraph.paragraph >= conclusionStart);
    const established = claims.filter(claim => !["unsupported", "partially_supported"].includes(claim.status)).map(claim => claim.sentence);

    const expectedBatch = batch.flatMap((paragraph) =>
      paragraph.sentences.map(({ text: sentence, sentenceIndex }) => ({ paragraph: paragraph.paragraph, sentence, sentenceIndex }))
    );
    const batchUrls = new Set(batch.flatMap(paragraph => paragraph.citedSources.flatMap(sentence => sentence.urls)).map(url => normalizeUrl(url || "")));
    const citedSources = usableSources.filter(source => !isConclusion && batchUrls.has(normalizeUrl(source.url)));
    const perSourceBudget = Math.max(1200, Math.floor(48_000 / Math.max(1, citedSources.length)));
    const auditSources = citedSources.map(source => ({...source, passages: relevantSourcePassages(source.passages,
      batch.flatMap(paragraph => paragraph.citedSources.filter(sentence => sentence.urls.some(url => normalizeUrl(url) === normalizeUrl(source.url))).map(sentence => sentence.sentence)), perSourceBudget)}));
    const cacheKey = createHash("sha256").update(JSON.stringify({batch, auditSources, established, fast: options.fast, topic: options.topic})).digest("hex");
    for (const [key, cached] of completedChecks) if (cached.expires < Date.now()) completedChecks.delete(key);
    const cached = completedChecks.get(cacheKey);
    if (cached) { options.signal?.throwIfAborted(); return Promise.resolve(structuredClone(cached.value)); }
    return completeJson(
    {
      system: isConclusion ? "CONCLUSION CHECK: Verify EVERY conclusion sentence exactly once using ONLY the supplied ESTABLISHED ESSAY statements. No source pages or outside knowledge are admissible. A faithful restatement or synthesis of those established points is supported, even when it restates factual content. Logical synthesis may be logical_inference; a transition or value judgment may be nonfactual. Mark any new fact, statistic, example, mechanism, argument, or recommendation unsupported, even if you know it is true. Use partially_supported when a sentence mixes established points with new information. Do not use common_knowledge to excuse new information. Return one claims entry for every paragraph and sentenceIndex. Keep the supplied indexes unchanged. For conclusion claims use no supporting source index and an empty supportingPassageIndexes array. Return raw JSON only." : `You are a strict academic source-grounding auditor. Classify EVERY supplied essay sentence exactly once. For every claim set onTopic to true or false using the stated essay topic and its paragraph heading. A statement may be faithfully quoted from a page yet still concern a different subject from the essay. Set onTopic=false for an unrelated subject or example, not for relevant context, required comparisons, limitations, or analysis. A citation does not make off-topic material relevant. Use supplied sourceText for specialised factual claims. Basic, widely established knowledge and warranted reasoning do not require citations. Use "supported" only when a source directly entails the entire material factual claim without adding precision, mechanism, causation, population, date, or statistics absent from the page. Use "partially_supported" if only part is entailed, and "unsupported" if none is. Use "common_knowledge" for stable, widely taught elementary facts, including basic scientific background, whether cited or uncited. Such facts need not appear in the supplied pages. Do not demand a citation for ordinary knowledge, personal evaluation, or a clear conclusion drawn from established evidence. Use "logical_inference" for reasoning warranted by established facts, without adding new empirical premises, and "nonfactual" for headings, transitions, thesis statements, recommendations, or value judgments. Specific scientific findings, specialised mechanisms, gene-level details, numerical measurements, comparisons of effectiveness, and study-specific claims require original source support even if the model remembers them. Never label these common knowledge simply because they sound familiar. Claims about a study's design, measurement methods, bias, confounders, or findings are factual and must be supported by that cited study. General explanations of why correlation does not establish causation may be logical analysis, but do not exempt claims about specific research. For every supported sentence, verify ONLY the original citedSources URLs for that sentence. Return supportingSourceIndex and supportingPassageIndexes for the numbered passages directly supporting the complete claim. Do not copy or paraphrase evidence quotations. Check every clause and every item in a list against the original cited page. If a topic list contains one extra topic absent from that page, it is partially_supported even if another supplied page mentions that topic. Descriptions of actual events, practices, methods, or results are factual, never mere logical analysis. Clearly labeled recommendations, future plans, and hypothetical scenarios are nonfactual unless they assert established facts or proven outcomes. If a proposal embeds factual background, that background still requires direct support. A writer's clearly evaluative comment about why a supported finding is relevant to the essay, or how the essay is organized, is nonfactual or logical_inference and does not require the page to discuss this essay. However, specialised mechanisms, empirical causal explanations, measured comparisons, and detailed scientific structures remain factual claims needing evidence even when presented as analysis. A heading, title, table label, or generic call for more research is not evidence for a detailed claim. Do not add citations to uncited factual sentences or search other pages for a replacement citation. For supported claims, return the supplied supportingSourceIndex and at least one supportingPassageIndexes entry. A supporting passage must mention the sentence's named examples, varieties, organisms, places, persons, and numbers; a real but unrelated passage is not support. For other statuses omit supportingSourceIndex and use an empty supportingPassageIndexes array. Identify each sentence by paragraph and sentenceIndex. Do not merge or split the supplied sentences. Return raw JSON only.`,
      user: `ESSAY TOPIC:\n${options.topic || "Not supplied; use paragraph headings."}\n\nESTABLISHED ESSAY:\n${JSON.stringify(established)}\n\nSOURCES:\n${JSON.stringify(auditSources.map(({ sourceIndex, title, publisher, url, passages }, localIndex) => ({ sourceIndex: options.fast ? localIndex : sourceIndex, title, publisher, url, passages: passages.map((passage, passageIndex) => ({passageIndex, text: passage.text})) })))}\n\nESSAY PARAGRAPHS AND SENTENCES:\n${JSON.stringify(batch)}\n\nReturn {"claims":[{"paragraph":0,"sentenceIndex":0,"status":"supported|partially_supported|unsupported|common_knowledge|logical_inference|nonfactual","onTopic":true,"supportingSourceIndex":0,"supportingPassageIndexes":[0],"reason":"brief source-specific reason"}]}. Include one entry for every supplied sentenceIndex, with no omissions or additions. supportingSourceIndex is the sourceIndex displayed above, never a footnote number. Keep the supplied passage indexes. Limit each reason to 15 words.`,
      temperature: 0.1,
      thinking: !options.fast,
      lowEffort: true,
      reasoningBudget: 1024,
      maxTokens: Math.max(6000, expectedBatch.length * 250 + 1500),
      tries: options.fast ? 2 : 4,
      signal: options.signal,
      timeoutMs: options.fast ? 45_000 : undefined,
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
        // Every expected sentence is present here; missing entries throw
        // above and are recovered by splitting, never marked unsupported.
        value.claims = expectedBatch.map((item) => {
          const claim = originalClaims.find((candidate) => candidate.paragraph === item.paragraph && (
            candidate.sentenceIndex === item.sentenceIndex ||
            (candidate.sentenceIndex === undefined && key(candidate.paragraph, candidate.sentence) === key(item.paragraph, item.sentence))
          ))!;
          return { ...claim, sentence: item.sentence, sentenceIndex: item.sentenceIndex };
        });
        for (const claim of value.claims) {
          if (options.fast && !isConclusion && claim.status === "supported" && claim.supportingSourceIndex !== undefined) {
            const selected = auditSources[claim.supportingSourceIndex];
            if (!selected) throw new Error(`Source index ${claim.supportingSourceIndex} is not supplied. Use sourceIndex 0 through ${auditSources.length - 1}, not a footnote number.`);
            claim.supportingSourceIndex = selected.sourceIndex;
          }
          // These assert external research or causal effects even when mixed
          // into a proposal. They cannot escape verification as "analysis".
          const explicitProposal = /\b(?:I propose|we propose|recommend|should|could|would)\b/i.test(claim.sentence);
          const researchAssertion = /\b(?:research (?:indicates|shows|demonstrates|links|suggests)|studies (?:show|indicate|demonstrate)|have been shown|has been shown|empirical studies|based on .*research|as supported by .*research|legal (?:and ethical )?requirement)\b/i.test(claim.sentence);
          const benefitAssertion = /\b(?:(?:improve|increase|reduce|enhance|boost)[sd]? (?:outcomes?|results?|performance|rates?|risk|efficiency|quality)|(?:help[s]?|enables|promotes))\b/i.test(claim.sentence);
          const factualAssertion = researchAssertion || (benefitAssertion && (!explicitProposal || /\b(?:because|proven|known to|already)\b/i.test(claim.sentence)));
          const specificMeasurement = /\b\d+(?:\.\d+)?\s*(?:%|percent\b|fold\b|times\b|mg\b|kg\b|milligrams?\b|kilograms?\b)/i.test(claim.sentence);
          // A stated concern with a specific external effect ("may disrupt
          // markets", "is linked to illness", "risks harming growers") is a
          // factual causal claim, not analysis — even when the essay's topic
          // is ethical or social. Vague value judgments without an external
          // effect ("we must weigh the risks") stay nonfactual.
          const concernAssertion = /\b(?:may|might|could|can|will|would)\s+(?:cause|lead to|result in|trigger|harm|damage|threaten|disrupt|undermine|exacerbat\w*|pose|create|raise|carry)\b/i.test(claim.sentence) ||
            /\b(?:risks?\s+(?:to|for|of)|side effects?|adverse effects?|linked to|associated with)\b/i.test(claim.sentence);
          const elementaryKnowledge = claim.status === "common_knowledge" && !researchAssertion && !specificMeasurement && !concernAssertion;
          if (isConclusion && claim.status === "supported") {
            // Here support means entailment by the established essay,
            // rather than a new claim requiring a source citation.
            claim.status = "logical_inference";
          }
          if (isConclusion && claim.status === "common_knowledge") {
            claim.status = "unsupported";
            claim.reason += " The conclusion may only synthesize the established essay, with no new factual material or citations.";
          }
          if (!isConclusion && options.topic && claim.onTopic === false) {
            claim.status = "unsupported";
            claim.reason += " The claim belongs to a different subject from this essay section.";
          }
          if (!isConclusion && (factualAssertion || specificMeasurement || concernAssertion) && !elementaryKnowledge && claim.status !== "supported" && claim.status !== "partially_supported" && claim.status !== "unsupported") {
            claim.status = "unsupported";
            claim.reason += " This contains a factual research, measurement, or risk assertion that needs direct cited support.";
          }
          if (claim.status !== "supported") continue;
          const source = claim.supportingSourceIndex !== undefined
            ? usableSources[claim.supportingSourceIndex]
            : sourceByNormalizedUrl.get(normalizeUrl(claim.supportingUrl));
          if (source && claim.supportingSourceIndex !== undefined) {
            claim.supportingUrl = source.url;
            const supplied = auditSources.find(item => item.sourceIndex === source.sourceIndex);
            if (claim.supportingPassageIndexes.some(index => !supplied?.passages[index])) {
              throw new Error("Use only passage indexes displayed for the selected source. Omitted page passages are not supplied indexes.");
            }
            claim.supportingPassageIndexes = claim.supportingPassageIndexes.map(index => supplied!.passages[index].passageIndex);
            const passages = claim.supportingPassageIndexes.map((index) => source.passages[index]?.text);
            claim.supportingQuote = passages.length > 0 && passages.every(Boolean) ? passages[0]! : "";
          }
          const cited = paragraphs[claim.paragraph]?.citedSources[claim.sentenceIndex!];
          // A verbatim quote from the right page is not enough: the passage
          // must actually mention what the sentence claims. A real but
          // unrelated passage (no shared names, terms, or numbers) cannot
          // support a claim naming examples it never mentions.
          if (claim.status === "supported") {
            const evidenceText = source && claim.supportingPassageIndexes.length
              ? claim.supportingPassageIndexes.map((index) => source.passages[index]?.text).filter(Boolean).join(" ")
              : claim.supportingQuote;
            const missing = uncoveredClaimTerms(claim.sentence, evidenceText || "");
            if (missing.length) {
              claim.status = "unsupported";
              claim.reason += ` The cited passage never mentions ${missing.slice(0, 3).join(", ")}, so it cannot support this claim.`;
              claim.supportingUrl = "";
              claim.supportingQuote = "";
            }
          }
          const quote = normQuote(claim.supportingQuote);
          if (claim.status === "supported" && (!source || !cited?.urls.some((url) => normalizeUrl(url || "") === normalizeUrl(claim.supportingUrl)) || quote.length < 20 || !normQuote(source.sourceText).includes(quote))) {
            claim.status = "unsupported";
            claim.reason += " The original citation has no verifiable supporting passage.";
            claim.supportingUrl = "";
            claim.supportingQuote = "";
          }

        }
      },
    },
    nimChatLong
  ).then(value => {
    if (completedChecks.size >= 40) completedChecks.delete(completedChecks.keys().next().value!);
    completedChecks.set(cacheKey, {expires: Date.now() + 10 * 60_000, value: structuredClone(value)});
    return value;
  });
  };
  const isRecoverableAuditError = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    return msg.includes("omitted sentence indexes") || msg.includes("passage indexes") || msg.includes("is not supplied");
  };
  const auditBatch = async (batch: typeof paragraphs): Promise<z.output<typeof GroundingAuditSchema>> => {
    try {
      return await auditBatchOnce(batch);
    } catch (err) {
      if (!isRecoverableAuditError(err)) throw err;
      options.signal?.throwIfAborted();
      // Smaller batches omit less. Split multi-paragraph batches first.
      if (batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        const first = await auditBatch(batch.slice(0, mid));
        const second = await auditBatch(batch.slice(mid));
        return { claims: [...first.claims, ...second.claims] };
      }
      const single = batch[0];
      if (!single || single.sentences.length <= 1) {
        // A single sentence that still cannot be audited is preserved uncited
        // downstream (no claim => original sentence kept). Missing entries
        // are never treated as evidence the sentence is unsupported.
        return { claims: [] };
      }
      // One long paragraph: audit each sentence half separately while keeping
      // the original paragraph and sentence indexes unchanged.
      const midSentence = Math.ceil(single.sentences.length / 2);
      const splitCited = (start: number, end: number) =>
        single.citedSources.length === single.sentences.length
          ? single.citedSources.slice(start, end)
          : single.citedSources;
      const firstHalf = { ...single, sentences: single.sentences.slice(0, midSentence), citedSources: splitCited(0, midSentence) };
      const secondHalf = { ...single, sentences: single.sentences.slice(midSentence), citedSources: splitCited(midSentence, single.sentences.length) };
      const first = await auditBatch([firstHalf]);
      const second = await auditBatch([secondHalf]);
      return { claims: [...first.claims, ...second.claims] };
    }
  };
  const batchSize = Math.max(1, Math.min(2, options.batchSize || 2));
  const batches = Array.from({ length: Math.ceil(conclusionStart / batchSize) }, (_, index) => paragraphs.slice(index * batchSize, Math.min(conclusionStart, index * batchSize + batchSize)));
  const claims: z.output<typeof GroundingAuditSchema>["claims"] = [];
  let nextBatch = 0;
  const worker = async () => {
    while (nextBatch < batches.length) {
      const result = await auditBatch(batches[nextBatch++]);
      claims.push(...result.claims);
    }
  };
  await worker();
  if (draft.conclusion.length) {
    const ending = await auditBatch(paragraphs.slice(conclusionStart));
    claims.push(...ending.claims);
  }
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
