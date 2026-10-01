import { z } from "zod";
import type { EssayDraft } from "./essay-types";
import { completeJson, nimChatLong, type ModelProvider } from "./nim";
import { citationScopes } from "./citation-runs";
import { normQuote, splitSentences } from "./validate";

const RelevanceSchema = z.object({decisions: z.array(z.object({
  paragraph: z.number().int().min(0), sentenceIndex: z.number().int().min(0),
  relevant: z.boolean(), reason: z.string(),
}))});

/** A focused topic check before source verification. A page can faithfully
 * support a sentence about the wrong subject; factual grounding alone cannot
 * decide whether that sentence belongs in this particular essay. */
export async function removeOffTopicProse(draft: EssayDraft, topic: string, signal?: AbortSignal, structureJson?: string, onProvider?: (provider: ModelProvider) => void, preserveTexts?: string[]): Promise<string[]> {
  let sectionPurposes: Array<{heading: string; points: string[]}> = [];
  try {
    const outline = JSON.parse(structureJson || "{}");
    sectionPurposes = Array.isArray(outline.sections) ? outline.sections.map((section: {heading?: string; paragraphs?: Array<{point?: string}>}) => ({
      heading: section.heading || "", points: (section.paragraphs || []).map(point => point.point || "").filter(Boolean),
    })) : [];
  } catch { /* The heading and topic still define the scope. */ }
  // The introduction frames the essay rather than developing section points,
  // so topicality review skips it: a relevance model cannot tell framing
  // from drift, and deleting the whole opening reads as a skipped
  // introduction. Factual claims there still face source verification.
  // Paragraph numbers stay global (introduction paragraphs first) so removed
  // reports align with the source audit's numbering.
  const paragraphs: Array<{heading: string; text: string; paragraph: number}> = [];
  draft.introduction.forEach((text) => paragraphs.push({heading: "Introduction", text, paragraph: paragraphs.length}));
  for (const section of draft.sections) {
    for (const text of section.paragraphs) {
      paragraphs.push({heading: section.heading, text, paragraph: paragraphs.length});
    }
  }
  const items = paragraphs
    .filter((item, index) => index >= draft.introduction.length)
    .map((item) => ({
      paragraph: item.paragraph, heading: item.heading,
      sentences: splitSentences(item.text).map((sentence, sentenceIndex) => ({
        sentenceIndex, text: sentence.replace(/\[\^\d+\]/g, "").trim(),
      })),
    }));
  // Small, independent checks keep a provider from mistaking the complete
  // essay embedded in a long request for a request to rewrite the essay.
  // Items hold global paragraph numbers (introduction paragraphs first),
  // so look them up by number, never by position.
  const byParagraph = new Map(items.map((item) => [item.paragraph, item]));
  const batches = Array.from({length: Math.ceil(items.length / 2)}, (_, index) => items.slice(index * 2, index * 2 + 2));
  const offTopic: Array<{paragraph: number; sentenceIndex: number; reason: string}> = [];
  for (let index = 0; index < batches.length; index += 2) {
    const results = await Promise.all(batches.slice(index, index + 2).map(async batch => {
      const allowed = new Set(batch.map(item => item.paragraph));
      return completeJson({
        system: "You are checking relevance, not writing an essay. Classify EVERY numbered sentence separately. The section purposes specify the actual requested object of study and analysis; they have equal authority to the overall title. Keep sentences that develop a requested section purpose even when its vocabulary differs from the title. Mark relevant=false when a sentence switches to a sibling object, population, product, or application instead of the requested one, even if it uses the same general technology or appears on a cited page. Rules or results for a different product do not establish rules or results for the requested product. Keep relevant context, requested comparisons, limitations, and reasoning. Do not let a relevant neighboring sentence make a different subject relevant. Apply this to any discipline or essay structure. Do not reproduce or rewrite the essay. Return only JSON with a decisions array and no other fields.",
        user: `ESSAY TOPIC: ${topic}\nASSIGNED SECTION PURPOSES: ${JSON.stringify(sectionPurposes)}\nSENTENCES TO CHECK: ${JSON.stringify(batch)}\nReturn {"decisions":[{"paragraph":number,"sentenceIndex":number,"relevant":true,"reason":"brief"}]} with EXACTLY one entry for every supplied sentence.`,
        schema: RelevanceSchema, responseFormat: {type: "json_object"},
        temperature: 0, thinking: false, maxTokens: 1800,
        timeoutMs: 45_000, tries: 2, parseTries: 2, signal, onProvider,
        validate: value => {
          const expected = batch.flatMap(item => item.sentences.map(sentence => `${item.paragraph}:${sentence.sentenceIndex}`));
          const returned = value.decisions.map(claim => `${claim.paragraph}:${claim.sentenceIndex}`);
          if (returned.length !== expected.length || new Set(returned).size !== expected.length || expected.some(key => !returned.includes(key))) {
            throw new Error("Classify every supplied sentence exactly once by its paragraph and sentence index.");
          }
          for (const claim of value.decisions) if (!allowed.has(claim.paragraph) || !byParagraph.get(claim.paragraph)?.sentences[claim.sentenceIndex]) {
            throw new Error("The relevance review used a nonexistent paragraph or sentence index.");
          }
        },
      }, nimChatLong);
    }));
    // User-supplied wording is never off-topic: the author placed it.
    const preserved = new Set((preserveTexts ?? []).map((t) => normQuote(t)));
    const isPreserved = (paragraph: number, sentenceIndex: number) => {
      const text = byParagraph.get(paragraph)?.sentences[sentenceIndex]?.text ?? "";
      return preserved.has(normQuote(text.replace(/\[\^\d+\]/g, "").trim()));
    };
    offTopic.push(...results.flatMap(result => result.decisions.filter(item => !item.relevant && !isPreserved(item.paragraph, item.sentenceIndex))));
  }
  const removed = offTopic.map(item => `paragraph ${item.paragraph}: off topic — “${byParagraph.get(item.paragraph)?.sentences[item.sentenceIndex]?.text ?? ""}” (${item.reason})`);
  if (!removed.length) return removed;
  const excluded = new Set(offTopic.map(item => `${item.paragraph}:${item.sentenceIndex}`));
  const rewritten = paragraphs.map((item, paragraph) => citationScopes(item.text)
    .filter((_, sentenceIndex) => !excluded.has(`${paragraph}:${sentenceIndex}`))
    .map(({sentence, ids}) => `${sentence.replace(/\[\^\d+\]/g, "").trim()}${ids.map(id => `[^${id}]`).join("")}`)
    .join(" "));
  let index = 0;
  draft.introduction = draft.introduction.map(() => rewritten[index++]);
  for (const section of draft.sections) section.paragraphs = section.paragraphs.map(() => rewritten[index++]);
  return removed;
}
