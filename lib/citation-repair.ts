import { z } from "zod";
import type { EssayDraft, SourceItem } from "./essay-types";
import { completeJson, nimChatLong } from "./nim";
import { buildWritingPlan, type WritingInput } from "./planned-writer";
import { auditAndAlignGrounding } from "./grounding-audit";
import { citationCounts } from "./citation-limits";
import { groupCitationRuns } from "./citation-runs";
import { workIdentity } from "./work-identity";
import { countWords } from "./docx-build";
import { sourceFindingSentences } from "./paragraph-plan";
import { normQuote } from "./validate";
import { cleanEssayVoice } from "./source-writer";

/** Repair audit losses without regenerating or re-auditing established prose.
 * Additions earn their citations through the same independent source audit. */
export async function repairCitationMinimums(draft: EssayDraft, input: WritingInput, sources: SourceItem[], signal?: AbortSignal) {
  const plan = buildWritingPlan(input, sources);
  const tokens = (text: string) => new Set((text.toLowerCase().match(/[a-z]{4,}/g) || []).map(word => word.replace(/s$/, "")));
  const candidates = sources.flatMap(source => sourceFindingSentences(source.content).flatMap(text =>
    plan.tasks.filter(task => task.role === "body").map(task => {
      const words = tokens(text);
      const score = [...tokens(`${plan.headings[task.section]} ${task.point}`)].filter(word => words.has(word)).length;
      return {section: task.section, sourceId: Number(source.id), text, score};
    }))).filter(fact => fact.score >= 2 && fact.text.split(/\s+/).length >= 8)
    .sort((a, b) => b.score - a.score);
  const attempted = new Set<string>();
  for (let attempt = 0; attempt < 2; attempt++) {
    const counts = citationCounts(draft);
    const neededWorks = Math.max(0, (input.minimumSources || 1) - counts.works);
    const neededNotes = Math.max(0, (input.minimumFootnotes || 1) - counts.footnotes);
    if (!neededWorks && !neededNotes) return;
    signal?.throwIfAborted();
    const citedIds = new Set([...draft.introduction, ...draft.sections.flatMap(s => s.paragraphs)]
      .flatMap(text => [...text.matchAll(/\[\^(\d+)\]/g)].map(match => Number(match[1]))));
    const usedWorks = new Set(draft.footnotes.filter(note => citedIds.has(note.id)).map(workIdentity));
    const selectedWorks = new Set<string>();
    const slots: {section: number; sourceId: number; text: string}[] = [];
    const existingText = normQuote([...draft.introduction, ...draft.sections.flatMap(section => section.paragraphs)].join(" ").replace(/\[\^\d+\]/g, ""));
    for (const fact of candidates) {
        const source = sources.find(source => Number(source.id) === fact.sourceId);
        if (!source || attempted.has(fact.text) || existingText.includes(normQuote(fact.text)) || draft.evidence.some(anchor => anchor.quote === fact.text)) continue;
        const work = workIdentity(source);
        if (neededWorks && (usedWorks.has(work) || selectedWorks.has(work))) continue;
        slots.push({section: fact.section, sourceId: fact.sourceId, text: fact.text});
        selectedWorks.add(work); attempted.add(fact.text);
        if (slots.length >= Math.max(neededWorks, neededNotes)) break;
    }
    if (!slots.length) return;
    const remainingWords = input.wordTarget + 400 - countWords(draft);
    if (remainingWords < slots.length * 15) return;
    // A very short 55-word cap made the model return the same valid 80-100
    // word addition on every retry, then escalated to a full essay rewrite.
    // The remaining essay budget is checked again after source verification.
    const wordsPerSlot = Math.min(110, Math.floor(remainingWords / slots.length));
    const response = await completeJson({
      system: "Extend the supplied verified essay only with the assigned source findings. Read the entire essay before writing. Do not repeat existing findings or rewrite existing prose. Return one brief addition for each slot in slot order. Use only that slot's observed finding, preserving qualifiers. Paraphrase it and explain its relevance to its section without inventing facts. Each addition ends with [^sourceId] for its assigned source. No other citations, introductions or conclusions. Minimum citation counts are floors, not caps.",
      user: JSON.stringify({topic: input.topic, instructions: input.instructionText, extraInstructions: input.extraInstructions,
        verifiedEssay: draft, slots: slots.map(slot => ({...slot, heading: draft.sections[slot.section]?.heading})), wordsPerAddition: wordsPerSlot}),
      schema: z.object({additions: z.array(z.string().min(20)).length(slots.length)}),
      temperature: 0.4, maxTokens: Math.max(1000, slots.length * wordsPerSlot * 5),
      thinking: false, tries: 3, parseTries: 2, timeoutMs: 45_000, signal,
      validate: response => response.additions.forEach((text, index) => {
        const ids = [...text.matchAll(/\[\^(\d+)\]/g)].map(match => Number(match[1]));
        if (!ids.length || ids.some(id => id !== slots[index].sourceId)) throw new Error("Each addition must cite only its assigned source ID.");
        if (text.replace(/\[\^\d+\]/g, "").split(/\s+/).length > wordsPerSlot) throw new Error(`Keep each addition within ${wordsPerSlot} words.`);
      }),
    }, nimChatLong);
    // Separate sections retain slot order and let the auditor index each
    // addition independently. None of the existing text enters this audit.
    const supplement: EssayDraft = {title: draft.title, introduction: [], conclusion: [],
      sections: slots.map((slot, index) => ({heading: draft.sections[slot.section].heading, paragraphs: [cleanEssayVoice(response.additions[index])]})),
      footnotes: sources.map(source => ({...source, id: Number(source.id), publisher: source.publisher || source.container})),
      worksCited: [], evidence: [], coverage: []};
    await auditAndAlignGrounding(supplement, sources, {signal, batchSize: 2, fast: true, topic: input.topic});
    // Some slots may be removed by verification. Their empty paragraph still
    // occupies its original index, so anchor positions keep their meaning.
    let nextId = Math.max(0, ...draft.footnotes.map(note => note.id));
    const remap = new Map(supplement.footnotes.map(note => [note.id, ++nextId]));
    const additions = supplement.sections.map(section => section.paragraphs.join(" "));
    if (countWords(draft) + additions.join(" ").replace(/\[\^\d+\]/g, "").split(/\s+/).filter(Boolean).length > input.wordTarget + 400) return;
    draft.footnotes.push(...supplement.footnotes.map(note => ({...note, id: remap.get(note.id)!})));
    additions.forEach((text, index) => {
      if (!text.trim()) return;
      const sectionIndex = slots[index].section;
      const section = draft.sections[sectionIndex];
      const paragraph = draft.introduction.length + draft.sections.slice(0, sectionIndex).reduce((sum, section) => sum + section.paragraphs.length, 0) + section.paragraphs.length - 1;
      section.paragraphs[section.paragraphs.length - 1] += " " + text.replace(/\[\^(\d+)\]/g, (_, id) => `[^${remap.get(Number(id))}]`);
      draft.evidence.push(...supplement.evidence.filter(anchor => anchor.paragraph === index).map(anchor => ({...anchor, paragraph, source: remap.get(anchor.source)!})));
    });
    groupCitationRuns(draft);
  }
}
