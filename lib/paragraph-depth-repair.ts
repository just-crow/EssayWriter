import { z } from "zod";
import type { EssayDraft, SourceItem } from "./essay-types";
import type { WritingInput } from "./planned-writer";
import { completeJson, nimChatLong, type ModelProvider } from "./nim";
import { auditAndAlignGrounding } from "./grounding-audit";
import { countWords } from "./docx-build";
import { normQuote } from "./validate";
import { groupCitationRuns } from "./citation-runs";
import { sourceFindingSentences, sourceQualityFactor } from "./paragraph-plan";
import { cleanEssayVoice } from "./source-writer";

const terms = (value: string) => new Set((value.toLowerCase().match(/[a-z]{4,}/g) || [])
  .filter(word => !/^(?:this|that|with|from|their|about|which|have|been|were|also|more|than|into)$/.test(word)));
const wordCount = (value: string) => value.replace(/\[\^\d+\]/g, "").split(/\s+/).filter(Boolean).length;

/** Develop thin, already verified sections from unused observed findings.
 * A failed optional expansion leaves the existing essay intact. */
export async function repairParagraphDepth(draft: EssayDraft, input: WritingInput, sources: SourceItem[], signal?: AbortSignal, onProvider?: (provider: ModelProvider) => void): Promise<boolean> {
  const goal = Math.min(input.wordTarget, Math.max(input.wordTarget - 150, Math.ceil(input.wordTarget * 0.85)));
  const initialWords = countWords(draft);
  const sectionWords = draft.sections.map(section => section.paragraphs.reduce((sum, paragraph) => sum + wordCount(paragraph), 0));
  if (initialWords >= goal && sectionWords.every(words => words >= 75)) return false;

  const usedQuotes = new Set(draft.evidence.map(anchor => normQuote(anchor.quote)));
  const usedProse = normQuote([...draft.introduction, ...draft.sections.flatMap(section => section.paragraphs)].join(" "));
  const candidates = sources.flatMap(source => sourceFindingSentences(source.content).map(text => ({
    sourceId: Number(source.id), text, quality: sourceQualityFactor(source), tokens: terms(text), key: normQuote(text),
  }))).filter(fact => fact.text.split(/\s+/).length >= 9 && !usedQuotes.has(fact.key) && !usedProse.includes(fact.key));
  const allSlots: Array<{section: number; sourceId: number; text: string}> = [];
  const used = new Set<string>();
  const plannedWords = draft.sections.map(() => 0);
  const slotGoal = Math.min(6, Math.max(draft.sections.length, Math.ceil(Math.max(0, goal - initialWords) / 65)));
  while (allSlots.length < slotGoal) {
    const rankedSections = draft.sections.map((_, index) => index)
      .sort((a, b) => sectionWords[a] + plannedWords[a] - sectionWords[b] - plannedWords[b]);
    let selected = false;
    for (const index of rankedSections) {
    const heading = draft.sections[index].heading;
    const wanted = terms(heading);
    const sectionText = terms(draft.sections[index].paragraphs.join(" "));
    const ranked = candidates.filter(fact => !used.has(fact.key)).map(fact => {
      const overlap = [...wanted].filter(word => fact.tokens.has(word)).length;
      const novelty = [...fact.tokens].filter(word => !sectionText.has(word)).length;
      return {fact, score: (overlap * 3 + Math.min(novelty, 8) * 0.25) * fact.quality};
    }).filter(item => item.score >= 3).sort((a, b) => b.score - a.score);
    if (!ranked.length) continue;
    allSlots.push({section: index, sourceId: ranked[0].fact.sourceId, text: ranked[0].fact.text});
    used.add(ranked[0].fact.key);
    plannedWords[index] += 65;
    selected = true;
    break;
    }
    if (!selected) break;
  }
  if (!allSlots.length) return false;

  // A provider output cap on a large slot batch must shrink the batch,
  // not abandon the repair: halve the slots once and retry.
  // Models cannot hit tiny word targets reliably with a citation plus
  // analysis inside; floor the request where short-form generation works.
  let activeSlots = allSlots;
  let wordsPerAddition = Math.max(55, Math.min(80, Math.ceil((goal - initialWords) / activeSlots.length) + 8));
  const requestAdditions = (useSlots: typeof slots, perAddition: number) => completeJson({
    system: "Extend an existing source-verified essay. Read all previous paragraphs before writing. Return one distinct addition for each requested section. Develop only the supplied unused finding in that section, faithfully paraphrase it, and explain its significance without repeating any existing claim, example, or wording. Cite it with the assigned [^sourceId]. Do not add unsourced facts. No headings, conclusion, raw Markdown, or introductory filler. Never use the em dash character or the semicolon character; use commas, full stops, colons, or parentheses instead. Each addition has a stated word budget: write no more than that many words, never more. Brevity is a hard constraint.",
    user: JSON.stringify({topic: input.topic, instructions: input.instructionText,
      previousEssay: {introduction: draft.introduction, sections: draft.sections, conclusion: draft.conclusion},
      slots: useSlots.map(slot => ({...slot, heading: draft.sections[slot.section].heading})), wordsPerAddition: perAddition}),
    schema: z.object({additions: z.array(z.string().min(25)).length(useSlots.length)}),
    temperature: 0.3, maxTokens: Math.max(2400, useSlots.length * perAddition * 7),
    thinking: false, tries: 2, parseTries: 2, timeoutMs: 45_000, signal, onProvider,
    validate: value => value.additions.forEach((text, index) => {
      const ids = [...text.matchAll(/\[\^(\d+)\]/g)].map(match => Number(match[1]));
      if (!ids.length || ids.some(id => id !== useSlots[index].sourceId)) throw new Error(`Use only [^${useSlots[index].sourceId}] in addition ${index + 1}.`);
      if (wordCount(text) > perAddition + 40) throw new Error(`Keep addition ${index + 1} near ${perAddition} words.`);
    }),
  }, nimChatLong);
  let response;
  try {
    response = await requestAdditions(activeSlots, wordsPerAddition);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    if (!/output limit/i.test(msg) || activeSlots.length < 2) throw err;
    activeSlots = activeSlots.slice(0, Math.ceil(activeSlots.length / 2));
    wordsPerAddition = Math.max(55, Math.min(80, Math.ceil((goal - initialWords) / activeSlots.length) + 8));
    response = await requestAdditions(activeSlots, wordsPerAddition);
  }
  const slots = activeSlots;
  const supplement: EssayDraft = {title: draft.title, introduction: [], conclusion: [],
    sections: slots.map((slot, index) => ({heading: draft.sections[slot.section].heading, paragraphs: [cleanEssayVoice(response.additions[index])]})),
    footnotes: sources.map(source => ({...source, id: Number(source.id), publisher: source.publisher || source.container})),
    worksCited: [], evidence: [], coverage: []};
  await auditAndAlignGrounding(supplement, sources, {signal, batchSize: 2, fast: true, topic: input.topic});
  const additions = supplement.sections.map(section => section.paragraphs.join(" ").trim());
  if (!additions.some(Boolean) || initialWords + additions.reduce((sum, text) => sum + wordCount(text), 0) > input.wordTarget + 400) return false;

  let nextId = Math.max(0, ...draft.footnotes.map(note => note.id));
  const remap = new Map(supplement.footnotes.map(note => [note.id, ++nextId]));
  draft.footnotes.push(...supplement.footnotes.map(note => ({...note, id: remap.get(note.id)!})));
  additions.forEach((text, index) => {
    if (!text || !supplement.evidence.some(anchor => anchor.paragraph === index)) return;
    const sectionIndex = slots[index].section;
    const section = draft.sections[sectionIndex];
    const paragraphIndex = draft.introduction.length + draft.sections.slice(0, sectionIndex)
      .reduce((sum, item) => sum + item.paragraphs.length, 0) + section.paragraphs.length - 1;
    section.paragraphs[section.paragraphs.length - 1] += " " + text.replace(/\[\^(\d+)\]/g, (_, id: string) => `[^${remap.get(Number(id))}]`);
    draft.evidence.push(...supplement.evidence.filter(anchor => anchor.paragraph === index)
      .map(anchor => ({...anchor, paragraph: paragraphIndex, source: remap.get(anchor.source)!})));
  });
  groupCitationRuns(draft);
  return countWords(draft) > initialWords;
}
