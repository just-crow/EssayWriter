import { z } from "zod";
import type { EssayDraft, SourceItem } from "./essay-types";
import { completeJson, nimChatLong } from "./nim";
import { splitSentences, normQuote } from "./validate";
import { planParagraphs } from "./paragraph-plan";

const ParagraphSchema = z.object({ paragraph: z.string().min(1) });
const editorialIssue = /\b(?:this|the) (?:review|article|paper|source) (?:explores|focuses|discusses|examines|reviews|emphasizes|states|notes)\b|\bassigned findings?\b|\bas we embark|threshold of a new era|\b(?:figure|table)\s+\d+|^(?:when combined|this approach|this integration)\b/i;

/** Standalone author-date debris lifted from source passages ("Mogo et al.,
 * 2019).", "Knecht 2004)."): a whole sentence with no claim in it. Inline
 * attributions inside real sentences ("Research by Wilson and Xiao (2023)
 * indicates...") are legitimate prose and are kept. */
export function isCitationDebris(sentence: string): boolean {
  const t = sentence.trim().replace(/\[\^\d+\]/g, "").trim();
  if (t.length < 4 || t.length > 120) return false;
  if (!/\(\d{4}\)|\b\d{4}\b/.test(t)) return false;
  // Nothing but capitalized name tokens plus a year and punctuation.
  const rest = t.replace(/\bet al\b\.?/gi, "").replace(/\(\d{4}\)|\b\d{4}\b|[(),;.:\-–—]/g, "").trim();
  const words = rest.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 3 &&
    words.every((w) => /^[A-Z][a-zÀ-ÿ\-']*\.?$/.test(w) || /^[A-Z]\.$/.test(w));
}

/** Routing labels leaked from task-based generation (">> section=2:",
 * "<<end>>", "Paragraph 3:"): staging directions, never essay prose. */
export function stripRoutingLabels(text: string): string {
  return text
    .replace(/>>\s*section\s*=?:?\s*\d+\s*:?/gi, "")
    .replace(/<<[^<>]*>>/g, "")
    .replace(/(^|[.!?]\s+)(?:paragraph|task|section)\s+\d+\s*:/gi, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function cleanEssayVoice(paragraph: string): string {
  // These refer to the generation inputs or an absent source illustration,
  // rather than contributing a claim to the essay. Factual verification follows.
  const kept = splitSentences(paragraph).filter(sentence =>
    !/\b(?:figure|table)\s+\d+\s+(?:illustrates|shows|summari[sz]es|depicts)/i.test(sentence) &&
    !/^(?:the|this) source that frames this discussion\b/i.test(sentence.trim()) &&
    !isCitationDebris(sentence)
  ).join(" ");
  const cleaned = kept
    .replace(/\*([^*]+)\*/g, "$1").replace(/‑/g, "-")
    .replace(/\s*—\s*/g, ", ").replace(/;\s*/g, ". ")
    .replace(/(^|\s)>\s*(?=[A-Z])/g, "$1")
    .replace(/(\[\^\d+\]|[.!?])\s+\)\s+(?=[A-Z])/g, "$1 ")
    .replace(/(^|[.!?]\s+)(?:Moreover|Furthermore|Additionally),?\s+([a-z])/g, (_, before: string, next: string) => before + next.toUpperCase())
    .replace(/\b(?:the )?assigned findings?\b/gi, match => /^[A-Z]/.test(match) ? "The available evidence" : "the available evidence")
    .replace(/\bavailable evidence do not\b/gi, "available evidence does not")
    // Typographic fallout from audits and repairs.
    .replace(/\s+([.,!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/\bThis (view|framework|interpretation|account) makes .*? relevant as\b/gi, "This suggests")
    .trim();
  return stripRoutingLabels(cleaned);
}

/** Compose independently assigned source findings, never an essay from memory. */
export async function composeSourceDraft(input: {
  topic: string; instructionText: string; extraInstructions: string;
  wordTarget: number; structureJson: string; minimumFootnotes?: number; minimumSources?: number;
}, sources: SourceItem[], feedback = "", previous?: EssayDraft): Promise<EssayDraft> {
  const { tasks, headings, endWords, thesis } = planParagraphs(input, sources);
  const auditedWorks = feedback.match(/from (\d+) distinct works/i);
  const needsDifferentWorks = !!auditedWorks && Number(auditedWorks[1]) < (input.minimumSources || 1);
  const results: string[] = new Array(tasks.length);
  const retained = previous ? tasks.map(task => {
    if (task.section < 0) return previous.introduction.length === 1 ? previous.introduction[0] : "";
    const old = previous.sections.find(section => section.heading === headings[task.section]);
    const sectionTasks = tasks.filter(item => item.section === task.section);
    // An audit can merge or remove prose in one section. It must not force
    // every other verified section and the introduction to be rewritten.
    return old?.paragraphs.length === sectionTasks.length ? old.paragraphs[sectionTasks.findIndex(item => item.index === task.index)] : "";
  }) : [];
  let next = 0;
  // The free endpoints share NVIDIA capacity. Avoid parallel paragraph
  // requests, which amplify overloads and compete with the source audit.
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      const prior = retained[task.index];
      const priorWords = prior?.replace(/\[\^\d+\]/g, "").split(/\s+/).filter(Boolean).length || 0;
      if (prior && !needsDifferentWorks && retained.length === tasks.length && priorWords >= task.words * 0.65 && priorWords <= task.words * 1.8 && splitSentences(prior).length >= 3) {
        // The route supplies only prose that survived source verification.
        // Retain complete paragraphs instead of regenerating valid content.
        results[task.index] = prior;
        continue;
      }
      const idsAllowed = new Set(task.assigned.map((finding) => finding.sourceId));
      const alreadyWritten = results.filter(Boolean);
      const request = {
        system: `You compose ONE paragraph of a source-based academic essay. The assigned findings are the only admissible external facts. Paraphrase the findings faithfully and cite them with their numeric [^sourceId] marker, grouping consecutive claims from the same work under one closing footnote. Allowed markers: ${[...idsAllowed].map((id) => `[^${id}]`).join(", ")}. Use these exact numeric markers, never placeholders. Derive the subject, essay type, purpose, and educational level exclusively from the user's topic and instructions. No subject or application domain is assumed. Develop the paragraph from several supplied findings and explain relationships only when the findings establish them. Preserve qualifiers exactly: almost every is not every, some is not all, can is not always. Do not fill space with remembered background facts, definitions, mechanisms, comparisons, claims of importance, or examples absent from the findings. Never reuse an example, statistic, or finding already developed in another paragraph. In evaluative discussion, pair every stated concern with supporting evidence or an explicit qualifier; do not assert unevidenced effects. Make recommendations only if the essay task requests them, and distinguish them clearly from established facts or proven outcomes. Keep factual clauses separate from your own evaluative commentary and cite factual sentences while writing. Consecutive sentences supported by the same work may share one citation placed at the end of that run, up to the previous footnote or paragraph boundary. Never extend that citation over claims the source does not support. When comparing two subjects, both sides of the comparison must be present in the findings. Write with concrete examples. Build an argument rather than a summary of a publication. Open with a self-contained topic sentence that answers the paragraph point, name the subject before using this approach or this technology, explain a concrete supported example, and connect it to the section question. Where the task asks for discussion or evaluation, weigh the supplied benefits against the supplied limitations and state a qualified judgment with a reason; do not invent missing trade-offs. Distinguish this reasoned judgment from external factual claims. Do not write This review explores, This review focuses, the article discusses, or other descriptions of the publication. Do not refer to the assigned finding, the task, or instructions in the essay. Do not use canned transitions such as Moreover or Furthermore. Avoid repeating sentences within or across paragraphs. Develop each finding once and use the earlier paragraphs to maintain continuity without copying their wording. Do not quote or repeat the source sentence verbatim. No em dashes or semicolons. Return only {"paragraph":"full paragraph"}.`,
        user: `Topic: ${input.topic}\nEssay thesis: ${thesis}\nInstructions: ${input.instructionText}\nAdditional instructions: ${input.extraInstructions}\nParagraph role: ${task.role}\nAlready written paragraphs (context only, do not repeat their wording or develop their findings again): ${JSON.stringify(alreadyWritten.map(paragraph => paragraph.replace(/\[\^\d+\]/g, "")))}\nSection question: ${task.section >= 0 ? headings[task.section] : input.topic}\nParagraph point to answer: ${task.point}\nAssessment criterion: ${task.criterion}\nAssessment strand: ${task.strand}\nAll paragraph purposes in essay order: ${JSON.stringify(tasks.map(t => ({section: t.section >= 0 ? headings[t.section] : "Introduction", point: t.point})))}\nAssigned source finding: ${JSON.stringify(task.finding)}\nAll assigned findings: ${JSON.stringify(task.assigned)}\nWrite approximately ${task.words} words in one developed paragraph with at least three sentences. Use the assigned findings as factual material for the word budget, with at least ${Math.max(1, Math.ceil((input.minimumFootnotes || 1) / tasks.length))} factual citations in this paragraph. You may combine related findings into one faithfully supported sentence and use more citations. Use only material relevant to this paragraph point. Explain the significance and limitations warranted by the assigned evidence instead of filling the word budget with a source overview. If evidence for an aspect of the point is absent, make a qualified evaluation of the available material without pretending the missing evidence exists. Minimum essay footnotes: ${input.minimumFootnotes || 1}. Minimum distinct cited works: ${input.minimumSources || 1}. These are minimums, not exact counts or caps: more are allowed when supported. Stay entirely within these findings. If a section asks about a subject absent from them, acknowledge the limit without importing remembered facts. Do not summarize other paragraphs or reuse their findings. \nCorrection feedback: ${feedback.slice(0, 2500)}`,
        schema: ParagraphSchema,
        temperature: 0.5, thinking: false,
        maxTokens: Math.max(2200, task.words * 4 + 800), tries: 4, parseTries: 3,
        retryTempDelta: 0,
        validate: (value: z.output<typeof ParagraphSchema>) => {
          let paragraph = value.paragraph;
          paragraph = paragraph.replace(/\*([^*]+)\*/g, "$1").replace(/\s*—\s*/g, ", ").replace(/;\s*/g, ". ").replace(/\[\s*\]/g, "").replace(/\s+([.,!?])/g, "$1");
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
          // The assigned work must cover the complete factual run, including
          // sentences after an early marker. Grouping later collapses the run
          // to its closing note; every clause still undergoes source auditing.
          if (idsAllowed.size === 1 && !/\[\^\d+\][.!?]?\s*$/.test(paragraph)) {
            paragraph += `[^${task.finding.sourceId}]`;
            value.paragraph = paragraph;
          }
          const finalIds = [...paragraph.matchAll(/\[\^(\d+)\]/g)].map((match) => Number(match[1]));
          if (!finalIds.length || [...idsAllowed].some((id) => !finalIds.includes(id))) throw new Error("Cite factual sentences using the paragraph's original assigned source ID. The complete essay will be independently checked for the requested citation minimums.");
          const words = paragraph.replace(/\[\^\d+\]/g, "").split(/\s+/).filter(Boolean).length;
          if (splitSentences(paragraph).length < 3) throw new Error("Use at least three complete sentences, each ending in punctuation. Separate the cited finding from the essay's analysis.");
          if (words < Math.max(30, Math.floor(task.words * 0.65)) || words > task.words * 1.8) throw new Error(`Write approximately ${task.words} words, currently ${words}. Use more of the supplied findings to reach the word budget. No outside facts or generic filler.`);
        },
      };
      let answer = await completeJson(request, nimChatLong);
      const copied = splitSentences(answer.paragraph).some(sentence => sentence.replace(/\[\^\d+\]/g, "").split(/\s+/).length >= 10 && task.assigned.some(fact => normQuote(sentence.replace(/\[\^\d+\]/g, "")) === normQuote(fact.text)));
      if (copied || editorialIssue.test(answer.paragraph)) {
        // Editorial improvements are advisory: preserve the valid paragraph
        // if the optional rewrite fails. Source auditing still runs later.
        try {
          const revised = await completeJson({ ...request, parseTries: 1,
            user: `${request.user}\n\nEDITORIAL REVISION: Rewrite the paragraph below into the essay's own argument, answering its paragraph point. Paraphrase copied source sentences while preserving their precise meaning. Remove descriptions of what a publication reviews or discusses, references to source figures or tables not present in this essay, and grandiose introductory language. Never mention assigned findings, this task, or missing aspects belonging to other sections. State a relevant evidence limitation in ordinary academic terms only when needed for this paragraph's point. Replace ambiguous opening references with an explicitly named subject. Use plain, specific academic prose with a qualified judgment where requested. Preserve the supported meaning, citations and qualifications. Return the full paragraph.\n${answer.paragraph}`,
          }, nimChatLong);
          if (!editorialIssue.test(revised.paragraph)) answer = revised;
        } catch { /* Editorial quality must not create a new draft error. */ }
      }
      results[task.index] = cleanEssayVoice(answer.paragraph);
    }
  };
  await worker();
  // Compose the conclusion last, exclusively from the essay already written.
  // It receives no unused source findings and cannot contribute citations.
  const ending = await completeJson({
    system: `Write one academic conclusion paragraph. No citations or footnote markers are allowed. Restate the thesis and synthesize only ideas already established in the supplied introduction and body. Introduce no new information: no new facts, evidence, statistics, examples, arguments, or recommendations. Do not use outside knowledge or source material. Return only {"paragraph":"..."}.`,
    user: `Topic: ${input.topic}\nEssay thesis: ${thesis}\nInstructions: ${input.instructionText}\nAlready written introduction and body:\n${JSON.stringify(results)}\nWrite approximately ${endWords} words, at least 30 words, in at least three sentences. Synthesize the essay without copying its sentences. No citations and no new information.`,
    schema: ParagraphSchema, temperature: 0.5, thinking: false,
    maxTokens: 2200, tries: 4, parseTries: 3, retryTempDelta: 0,
    validate: value => {
      if (/\[\^[^\]]+\]/.test(value.paragraph)) throw new Error("The conclusion must contain no citations. Summarize only points already established in the essay.");
      value.paragraph = value.paragraph.replace(/\s*—\s*/g, ", ").replace(/;\s*/g, ". ");
      if (value.paragraph.split(/\s+/).filter(Boolean).length < 30 || splitSentences(value.paragraph).length < 3) throw new Error("Write a developed conclusion of at least 30 words and three sentences, without new information or citations.");
    },
  }, nimChatLong);
  return {
    title: input.topic, introduction: [results[0]],
    sections: headings.map((heading, section) => ({ heading, paragraphs: tasks.filter((task) => task.section === section).map((task) => results[task.index]) })),
    conclusion: [ending.paragraph], footnotes: [], evidence: [], worksCited: [], coverage: [],
  };
}
