import { z } from "zod";
import type { EssayDraft, SourceItem } from "./essay-types";
import { completeJson, nimChatLong } from "./nim";
import { splitSentences } from "./validate";

const ParagraphSchema = z.object({ paragraph: z.string().min(1) });

/** Compose independently assigned source findings, never an essay from memory. */
export async function composeSourceDraft(input: {
  topic: string; instructionText: string; extraInstructions: string;
  wordTarget: number; structureJson: string; minimumFootnotes?: number; minimumSources?: number;
}, sources: SourceItem[], feedback = "", previous?: EssayDraft): Promise<EssayDraft> {
  const perSource = sources.map((source) => splitSentences(source.content)
    .filter((text) => text.split(/\s+/).length >= 6)
    .map((text) => ({ sourceId: Number(source.id), title: source.title, text })));
  const findings: Array<{ sourceId: number; title: string; text: string }> = [];
  for (let index = 0; index < Math.max(0, ...perSource.map((items) => items.length)); index++) {
    for (const items of perSource) if (items[index]) findings.push(items[index]);
  }
  if (!findings.length) throw new Error("The selected pages contain no substantive findings. Gather sources again.");
  const outline = JSON.parse(input.structureJson) as { sections?: Array<{ heading?: string }> };
  const headings = (outline.sections || []).map((section) => section.heading || "Discussion");
  if (!headings.length) headings.push("Discussion");
  const bodyCount = Math.max(headings.length, Math.round(input.wordTarget / 150) - 2, (input.minimumSources || 1) - 2, (input.minimumFootnotes || 1) - 2, 1);
  const endWords = Math.max(35, Math.min(120, Math.round(input.wordTarget / 8)));
  const bodyWords = Math.max(60, Math.round((input.wordTarget - 2 * endWords) / bodyCount));
  const usedFindings = new Set<number>();
  const usedWorks = new Set<number>();
  const tasks = Array.from({ length: bodyCount + 2 }, (_, index) => {
    const role = index === 0 ? "introduction" : index === bodyCount + 1 ? "conclusion" : "body";
    const section = role === "body" ? Math.min(headings.length - 1, Math.floor((index - 1) * headings.length / bodyCount)) : -1;
    const words = role === "body" ? bodyWords : endWords;
    const quota = Math.min(findings.length, Math.max(1, Math.ceil((input.minimumFootnotes || 1) / (bodyCount + 2)), Math.ceil(words / 40)));
    const terms = new Set(`${input.topic} ${section >= 0 ? headings[section] : ""}`.toLowerCase().match(/[a-z]{4,}/g) || []);
    const ranked = findings.map((finding, findingIndex) => ({ finding, findingIndex,
      score: [...new Set(finding.text.toLowerCase().match(/[a-z]{4,}/g) || [])].filter(term => terms.has(term)).length,
    })).sort((a, b) => Number(usedFindings.has(a.findingIndex)) - Number(usedFindings.has(b.findingIndex)) || b.score - a.score);
    const first = (usedWorks.size < (input.minimumSources || 1) ? ranked.find(item => !usedWorks.has(item.finding.sourceId)) : undefined) || ranked[0];
    // Keep a paragraph's source attribution unambiguous while supplying
    // several actual findings from that work. Different paragraphs cover
    // different works to satisfy the essay-wide diversity minimum.
    const assigned: typeof findings = [];
    let evidenceWords = 0;
    for (const item of ranked.filter(item => item.finding.sourceId === first.finding.sourceId)) {
      assigned.push(item.finding); usedFindings.add(item.findingIndex);
      evidenceWords += item.finding.text.split(/\s+/).length;
      if (assigned.length >= quota && evidenceWords >= words * 1.2) break;
    }
    usedWorks.add(first.finding.sourceId);
    return { index, role, section, words: role === "body" ? bodyWords : endWords, finding: assigned[0], assigned };
  });
  const results: string[] = new Array(tasks.length);
  const retained = previous ? [...previous.introduction, ...previous.sections.flatMap(section => section.paragraphs), ...previous.conclusion] : [];
  let next = 0;
  // Two independent paragraphs at a time bounds model load and context size.
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      const prior = retained[task.index];
      const priorWords = prior?.replace(/\[\^\d+\]/g, "").split(/\s+/).filter(Boolean).length || 0;
      if (prior && !feedback.includes("distinct works are required") && retained.length === tasks.length && priorWords >= task.words * 0.65 && priorWords <= task.words * 1.8 && splitSentences(prior).length >= 3) {
        // The route supplies only prose that survived source verification.
        // Retain complete paragraphs instead of regenerating valid content.
        results[task.index] = prior;
        continue;
      }
      const idsAllowed = new Set(task.assigned.map((finding) => finding.sourceId));
      const answer = await completeJson({
        system: `You compose ONE paragraph of a source-based academic essay. The assigned findings are the only admissible external facts. Paraphrase the findings faithfully and cite them with their numeric [^sourceId] marker, grouping consecutive claims from the same work under one closing footnote. Allowed markers: ${[...idsAllowed].map((id) => `[^${id}]`).join(", ")}. Use these exact numeric markers, never placeholders. Derive the subject, essay type, purpose, and educational level exclusively from the user's topic and instructions. No subject or application domain is assumed. Develop the paragraph from several supplied findings and explain relationships only when the findings establish them. Preserve qualifiers exactly: almost every is not every, some is not all, can is not always. Do not fill space with remembered background facts, definitions, mechanisms, comparisons, claims of importance, or examples absent from the findings. Make recommendations only if the essay task requests them, and distinguish them clearly from established facts or proven outcomes. Keep factual clauses separate from your own evaluative commentary and cite factual sentences while writing. Consecutive sentences supported by the same work may share one citation placed at the end of that run, up to the previous footnote or paragraph boundary. Never extend that citation over claims the source does not support. When comparing two subjects, both sides of the comparison must be present in the findings. Write natural academic prose with concrete examples and varied sentence lengths. Do not refer to the assigned finding, the task, or instructions in the essay. Do not use canned transitions such as Moreover or Furthermore. Do not quote or repeat the source sentence verbatim. No em dashes or semicolons. Return only {"paragraph":"full paragraph"}.`,
        user: `Topic: ${input.topic}\nInstructions: ${input.instructionText}\nAdditional instructions: ${input.extraInstructions}\nParagraph role: ${task.role}\nSection question: ${task.section >= 0 ? headings[task.section] : input.topic}\nAssigned source finding: ${JSON.stringify(task.finding)}\nAll assigned findings: ${JSON.stringify(task.assigned)}\nWrite approximately ${task.words} words in one developed paragraph with at least three sentences. Use the assigned findings as factual material for the word budget, with at least ${Math.max(1, Math.ceil((input.minimumFootnotes || 1) / tasks.length))} factual citations in this paragraph. You may combine related findings into one faithfully supported sentence and use more citations. There is enough factual material here: paraphrase and organize it into the requested word budget rather than adding outside facts. Minimum essay footnotes: ${input.minimumFootnotes || 1}. Minimum distinct cited works: ${input.minimumSources || 1}. These are minimums, not exact counts or caps: more are allowed when supported. Stay entirely within these findings. If a section asks about a subject absent from them, acknowledge the limit without importing remembered facts. Do not summarize other paragraphs or reuse their findings. ${task.role === "conclusion" ? "Close with a topic-appropriate synthesis of these source findings and their limits. Follow the conclusion requirements in the user's essay task." : ""}\nCorrection feedback: ${feedback.slice(0, 2500)}`,
        schema: ParagraphSchema, responseFormat: { type: "json_object" },
        temperature: 0.7, thinking: false,
        maxTokens: Math.max(2200, task.words * 4 + 800), tries: 2, parseTries: 2,
        retryTempDelta: 0,
        validate: (value) => {
          let paragraph = value.paragraph;
          paragraph = paragraph.replace(/\s*—\s*/g, ", ").replace(/;\s*/g, ". ").replace(/\[\s*\]/g, "").replace(/\s+([.,!?])/g, "$1");
          value.paragraph = paragraph;
          const ids = [...paragraph.matchAll(/\[\^(\d+)\]/g)].map((match) => Number(match[1]));
          if (ids.some((id) => !idsAllowed.has(id))) throw new Error(`Use only ${[...idsAllowed].map((id) => `[^${id}]`).join(", ")} for the assigned findings.`);
          // This source was assigned before composition. Bind an omitted
          // marker to that assignment, never search for a replacement page.
          // Every resulting sentence still undergoes independent verification.
          if (!ids.length && idsAllowed.size === 1) {
            paragraph = paragraph.replace(/\[\^sourceId\]/g, "");
            const sentences = splitSentences(paragraph);
            sentences[sentences.length - 1] += `[^${task.finding.sourceId}]`;
            paragraph = sentences.join(" ");
            value.paragraph = paragraph;
          }
          const finalIds = [...paragraph.matchAll(/\[\^(\d+)\]/g)].map((match) => Number(match[1]));
          if (!finalIds.length || [...idsAllowed].some((id) => !finalIds.includes(id))) throw new Error("Cite factual sentences using the paragraph's original assigned source ID. The complete essay will be independently checked for the requested citation minimums.");
          const words = paragraph.replace(/\[\^\d+\]/g, "").split(/\s+/).filter(Boolean).length;
          if (splitSentences(paragraph).length < 3) throw new Error("Use at least three complete sentences, each ending in punctuation. Separate the cited finding from the essay's analysis.");
          if (words < Math.max(30, Math.floor(task.words * 0.65)) || words > task.words * 1.8) throw new Error(`Write approximately ${task.words} words, currently ${words}. Use more of the supplied findings to reach the word budget. No outside facts or generic filler.`);
        },
      }, nimChatLong);
      results[task.index] = answer.paragraph;
    }
  };
  const workers = await Promise.allSettled([worker(), worker()]);
  const failure = workers.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return {
    title: input.topic, introduction: [results[0]],
    sections: headings.map((heading, section) => ({ heading, paragraphs: tasks.filter((task) => task.section === section).map((task) => results[task.index]) })),
    conclusion: [results.at(-1)!], footnotes: [], evidence: [], worksCited: [], coverage: [],
  };
}
