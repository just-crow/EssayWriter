import { z } from "zod";
import type { EssayDraft } from "./essay-types";
import { completeJson, nimChatLong } from "./nim";
import { citationScopes } from "./citation-runs";
import { splitSentences } from "./validate";

const RelevanceSchema = z.object({decisions: z.array(z.object({
  paragraph: z.number().int().min(0), sentenceIndex: z.number().int().min(0),
  relevant: z.boolean(), reason: z.string(),
}))});

/** A focused topic check before source verification. A page can faithfully
 * support a sentence about the wrong subject; factual grounding alone cannot
 * decide whether that sentence belongs in this particular essay. */
export async function removeOffTopicProse(draft: EssayDraft, topic: string, signal?: AbortSignal, structureJson?: string): Promise<string[]> {
  let sectionPurposes: Array<{heading: string; points: string[]}> = [];
  try {
    const outline = JSON.parse(structureJson || "{}");
    sectionPurposes = Array.isArray(outline.sections) ? outline.sections.map((section: {heading?: string; paragraphs?: Array<{point?: string}>}) => ({
      heading: section.heading || "", points: (section.paragraphs || []).map(point => point.point || "").filter(Boolean),
    })) : [];
  } catch { /* The heading and topic still define the scope. */ }
  const paragraphs = [
    ...draft.introduction.map(text => ({heading: "Introduction", text})),
    ...draft.sections.flatMap(section => section.paragraphs.map(text => ({heading: section.heading, text}))),
  ];
  const items = paragraphs.map((item, paragraph) => ({
    paragraph, heading: item.heading,
    sentences: splitSentences(item.text).map((sentence, sentenceIndex) => ({
      sentenceIndex, text: sentence.replace(/\[\^\d+\]/g, "").trim(),
    })),
  }));
  // Small, independent checks keep a provider from mistaking the complete
  // essay embedded in a long request for a request to rewrite the essay.
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
        timeoutMs: 45_000, tries: 2, parseTries: 2, signal,
        validate: value => {
          const expected = batch.flatMap(item => item.sentences.map(sentence => `${item.paragraph}:${sentence.sentenceIndex}`));
          const returned = value.decisions.map(claim => `${claim.paragraph}:${claim.sentenceIndex}`);
          if (returned.length !== expected.length || new Set(returned).size !== expected.length || expected.some(key => !returned.includes(key))) {
            throw new Error("Classify every supplied sentence exactly once by its paragraph and sentence index.");
          }
          for (const claim of value.decisions) if (!allowed.has(claim.paragraph) || !items[claim.paragraph]?.sentences[claim.sentenceIndex]) {
            throw new Error("The relevance review used a nonexistent paragraph or sentence index.");
          }
        },
      }, nimChatLong);
    }));
    offTopic.push(...results.flatMap(result => result.decisions.filter(item => !item.relevant)));
  }
  const removed = offTopic.map(item => `paragraph ${item.paragraph}: off topic — “${items[item.paragraph].sentences[item.sentenceIndex].text}” (${item.reason})`);
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
