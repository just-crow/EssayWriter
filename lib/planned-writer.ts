import type { EssayDraft, SourceItem } from "./essay-types";
import { z } from "zod";
import { createHash } from "node:crypto";
import { completeJson, nimChatLong } from "./nim";
import { planParagraphs, sourceFindingSentences } from "./paragraph-plan";
import { cleanEssayVoice } from "./source-writer";
import { normQuote, consolidateSectionParagraphs } from "./validate";
import { citationScopes } from "./citation-runs";
import { workIdentity } from "./work-identity";
import { SOURCE_BASED_ARGUMENT_GUIDANCE } from "./prompts";

export interface WritingInput {
  topic: string; instructionText: string; extraInstructions: string;
  wordTarget: number; structureJson: string; minimumFootnotes?: number; minimumSources?: number;
}

const tokens = (text: string) => new Set((text.toLowerCase().match(/[a-z]{4,}/g) || []).map(word => word.replace(/s$/, "")));
export const normalizeCitationMarkers = (text: string) => text.replace(/[【［]\s*\^?\s*(\d+)\s*[】］]/g, (_, id: string) => `[^${Number(id)}]`);
const completedDrafts = new Map<string, {expires: number; draft: EssayDraft}>();
const writerTask = (task: ReturnType<typeof buildWritingPlan>["tasks"][number], headings: string[]) => ({
  index: task.index, role: task.role, section: task.section, words: task.words, point: task.point,
  criterion: task.criterion, strand: task.strand,
  heading: task.section >= 0 ? headings[task.section] : "Introduction",
  assigned: task.assigned.map(({sourceId, text}) => ({sourceId, text})),
});
const previousProse = (draft?: EssayDraft) => draft ? ({
  title: draft.title, introduction: draft.introduction,
  sections: draft.sections, conclusion: draft.conclusion,
}) : null;

function isTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /model service error|connection error|ECONNRESET|socket hang up|stream timed out|stream terminated|service temporarily overloaded/i.test(message);
}

/** A shorter request can finish when the provider drops an essay-sized stream. */
async function composeInChunks(
  input: WritingInput,
  plan: ReturnType<typeof buildWritingPlan>,
  feedback: string,
  signal?: AbortSignal
): Promise<{ title: string; paragraphs: string[]; conclusion: string }> {
  // Small response groups stay clear of provider output caps: a rambling
  // long group aborts the whole essay, while an extra short call is cheap.
  const groupCount = plan.tasks.length > 4 ? 4 : plan.tasks.length > 2 ? 2 : 1;
  const groupSize = Math.max(1, Math.ceil(plan.tasks.length / groupCount));
  const groups = Array.from({ length: Math.ceil(plan.tasks.length / groupSize) }, (_, index) =>
    plan.tasks.slice(index * groupSize, (index + 1) * groupSize));
  const paragraphs: string[] = [];
  let conclusion = "";
  let title = input.topic;
  for (const [index, tasks] of groups.entries()) {
    signal?.throwIfAborted();
    const last = index === groups.length - 1;
    const result = await completeJson({
      system: `Continue a source-based academic essay. ${SOURCE_BASED_ARGUMENT_GUIDANCE} Return JSON with title, paragraphs, and conclusion. Write exactly one finished prose paragraph for each supplied task in order, close to its word budget. Do not include plans, word-count notes, source titles, source excerpts, lists, or explanations of what you will write. Paraphrase each finding and use only that task's assigned findings for specialised facts. Keep each paragraph under its own task's section; never move material into another section and never emit routing labels, task indexes, or staging directions. State magnitudes, extents, and comparisons only with quantities stated in the passage; drop bare intensifiers (significantly, dramatically, substantially, markedly, clearly, robust) unless the passage uses them. Cite each factual run with [^sourceId], closing one source's run before using another source. A closing marker may cover consecutive sentences supported by the same work. Every body paragraph and the introduction MUST contain at least one [^sourceId] citation to its own assigned findings, even a primarily evaluative paragraph: open with the assigned finding, then evaluate it. A body or introduction paragraph without any citation marker is a defect. When paraphrasing, retain the passage's key terms verbatim (group names, measures, outcomes, qualifiers) instead of substituting synonyms: if the passage says disadvantaged groups have less access, do not rewrite it as marginalized groups experience limited access. Each cited sentence must share its source's vocabulary so the claim stays traceable to its passage. The earlier paragraphs are context: advance their argument without repeating their findings, examples, or wording. Keep claims qualified to the supplied evidence. Explain significance and limitations warranted by that evidence, without inventing facts. No em dashes or semicolons. ${last ? "Write a citation-free conclusion that synthesizes only the completed essay, with no new information." : "Set conclusion to an empty string; the final group will write it."}`,
      user: JSON.stringify({ topic: input.topic, instructions: input.instructionText, extraInstructions: input.extraInstructions,
        thesis: plan.thesis, feedback, previousParagraphs: paragraphs,
        tasks: tasks.map(task => writerTask(task, plan.headings)),
        conclusionBrief: last ? plan.conclusionBrief : "", conclusionWords: last ? plan.endWords : 0,
        output: { title: "essay title", paragraphs: tasks.map(task => `paragraph for index ${task.index}`), conclusion: last ? "final synthesis" : "" } }),
      schema: z.object({ title: z.string(), paragraphs: z.array(z.string().min(120)).length(tasks.length), conclusion: z.string() }),
      responseFormat: { type: "json_object" },
      thinking: true, lowEffort: true, reasoningBudget: 128,
      temperature: 0.4, maxTokens: Math.max(2500, tasks.reduce((total, task) => total + task.words, 0) * 5 + 600),
      timeoutMs: 90_000, tries: 1, parseTries: 2, retryTempDelta: 0, signal,
      validate: value => {
        value.paragraphs = value.paragraphs.map(normalizeCitationMarkers);
        // Citations must come from the essay's evidence plan. Prefer each
        // paragraph to use its own assigned findings (the prompt says so),
        // but tolerate spillover to other planned IDs: the writer's relevance
        // judgment sometimes beats TF-IDF assignment, and the source audit
        // independently verifies every cited sentence against its page.
        // Only invented IDs outside the plan fail the paragraph.
        const planned = new Set(plan.requiredSourceIds);
        const invalid = value.paragraphs.flatMap(paragraph =>
          [...paragraph.matchAll(/\[\^(\d+)\]/g)]
            .map(match => Number(match[1]))
            .filter(id => !planned.has(id)));
        if (invalid.length) throw new Error(`Use only the planned source IDs, not ${invalid.join(", ")}.`);
        // A paragraph with no markers at all would pass the check above
        // silently and fail the whole essay at the end. Demand the citation
        // here, where the retry still has the paragraph's assigned findings.
        const uncited = value.paragraphs
          .map((paragraph, paragraphIndex) => ({ paragraph, paragraphIndex }))
          .filter(({ paragraph, paragraphIndex }) => tasks[paragraphIndex].role !== "conclusion" && !/\[\^\d+\]/.test(paragraph))
          .map(({ paragraphIndex }) => tasks[paragraphIndex].index);
        if (uncited.length) throw new Error(`Cite the assigned findings in paragraph indexes ${uncited.join(", ")} with [^sourceId] markers. Every body paragraph needs at least one citation.`);
        // Writers under-write: hold every paragraph to two-thirds of its word
        // budget and the conclusion to two-thirds of its target, while the
        // retry still has context. The ±400-word tolerance absorbs overshoot.
        // Budgets run 25% above nominal and writers reach roughly 70% of
        // nominal, so the floor sits at 55% of budget: it truncates the weak
        // tail without demanding output the model cannot sustain.
        const proseWords = (text: string) => text.replace(/\[\^\d+\]/g, "").split(/\s+/).filter(Boolean).length;
        const thin = value.paragraphs
          .map((paragraph, paragraphIndex) => ({ paragraph, paragraphIndex }))
          .filter(({ paragraph, paragraphIndex }) => proseWords(paragraph) < Math.max(45, Math.round(tasks[paragraphIndex].words * 0.55)))
          .map(({ paragraphIndex }) => tasks[paragraphIndex].index);
        if (thin.length) throw new Error(`Develop paragraph indexes ${thin.join(", ")} toward their word budgets with more assigned evidence and analysis. Thin paragraphs leave the essay short of its target.`);
        if (last && /\[\^\d+\]/.test(value.conclusion)) throw new Error("The conclusion must have no citations.");
        if (last && proseWords(value.conclusion) < Math.max(35, Math.round(plan.endWords * 0.55))) throw new Error(`Write a developed conclusion of at least ${Math.max(35, Math.round(plan.endWords * 0.55))} words restating the thesis and key reasons, not meta-commentary about the discussion.`);
      },
    }, nimChatLong);
    title = result.title || title;
    paragraphs.push(...result.paragraphs);
    if (last) conclusion = result.conclusion;
  }
  return { title, paragraphs, conclusion };
}

export function removeRepeatedProse(paragraphs: string[]): string[] {
  const seen = new Set<string>();
  return paragraphs.map(paragraph => {
    const kept: Array<{text: string; words: Set<string>}> = [];
    for (const {sentence, ids} of citationScopes(paragraph)) {
    const text = sentence.replace(/\[\^\d+\]/g, "").replace(/\*([^*]+)\*/g, "$1").replace(/\s*—\s*/g, ", ").replace(/;\s*/g, ". ").replace(/\s+([.,!?])/g, "$1").trim();
    if (/^(?:this|the) (?:essay|introduction|paragraph|section) (?:sets? out|aims? to|will|explores?|discusses?|evaluates?|considers?)\b/i.test(text)) continue;
    const key = normQuote(text);
    const substantial = text.split(/\s+/).length >= 12;
    if (substantial && seen.has(key)) continue;
    const words = tokens(text);
    // Catch a paraphrased restatement within one paragraph while retaining
    // its first sourced occurrence. A high shared-word floor avoids treating
    // ordinary topic overlap as duplication.
    const repeated = substantial && kept.some(prior => {
      const shared = [...words].filter(word => prior.words.has(word)).length;
      return shared >= 12 && shared / Math.min(words.size, prior.words.size) >= 0.5;
    });
    if (repeated) continue;
    if (substantial) seen.add(key);
    // Keep the original citation scope when removing a repeated closing
    // sentence. Grouping after auditing still produces one closing note.
    kept.push({text: `${text}${ids.map(id => `[^${id}]`).join("")}`, words});
    }
    return kept.map(item => item.text).join(" ");
  });
}

/** Reserve relevant evidence from every required work before writing. More
 * than one work can develop a paragraph; citation sliders do not dictate
 * paragraph count or force the writer to repeat a source's introduction. */
export function buildWritingPlan(input: WritingInput, sources: SourceItem[]) {
  const plan = planParagraphs({ ...input, maxAssignedFindings: 3, minimumSources: 1, minimumFootnotes: Math.ceil((input.minimumFootnotes || 1)/(input.minimumSources || 1)) }, sources);
  const workById = new Map(sources.map(source => [Number(source.id), workIdentity(source)]));
  const usedText = new Set(plan.tasks.flatMap(task => task.assigned.map(fact => normQuote(fact.text))));
  const works = new Set(plan.tasks.flatMap(task => task.assigned.map(fact => workById.get(fact.sourceId))));
  const topic = tokens(input.topic);
  const candidates = sources.flatMap(source => sourceFindingSentences(source.content)
    .filter(text => text.split(/\s+/).length >= 8 && text.split(/\s+/).length <= 100 &&
      !/creative commons|all rights reserved|cookie|subscribe|figure \d+ illustrates|this (?:review|article) (?:explores|discusses)/i.test(text))
    .map(text => ({sourceId: Number(source.id), title: source.title, text, work: workIdentity(source), words: tokens(text)})));
  const rank = (fact: typeof candidates[number], task: typeof plan.tasks[number]) => {
    const wanted = tokens(`${task.section >= 0 ? plan.headings[task.section] : input.topic} ${task.point}`);
    return [...wanted].reduce((n, word) => n + (fact.words.has(word) ? topic.has(word) ? 0.2 : 1 : 0), 0);
  };
  // The best relevant new finding from each unused work competes for a slot.
  const reserve = (newWork: boolean) => {
    const choices = candidates.filter(fact => fact.work && !usedText.has(normQuote(fact.text)) && (!newWork || !works.has(fact.work)))
      .flatMap(fact => plan.tasks.filter(task => task.role === "body").map(task => ({fact, task, score: rank(fact, task)})))
      .filter(choice => choice.score > 0.2)
      .sort((a, b) => b.score - a.score || a.task.assigned.length - b.task.assigned.length);
    const choice = choices[0];
    if (!choice) return false;
    choice.task.assigned.push({sourceId: choice.fact.sourceId, title: choice.fact.title, text: choice.fact.text});
    usedText.add(normQuote(choice.fact.text)); works.add(choice.fact.work);
    return true;
  };
  while (works.size < (input.minimumSources || 1) && reserve(true)) { /* reserve actual works */ }
  if (works.size < (input.minimumSources || 1)) throw new Error(`The gathered evidence can support ${works.size} relevant distinct works, but you requested ${input.minimumSources}. Gather more relevant sources before drafting, or reduce the minimum cited works. No essay was generated.`);
  // Separate factual findings can justify separate notes. Repeating the same
  // work solely to manufacture a quota is never a reserved evidence slot.
  while (usedText.size < (input.minimumFootnotes || 1) && reserve(false)) { /* reserve new findings */ }
  if (usedText.size < (input.minimumFootnotes || 1)) throw new Error(`The gathered pages provide only ${usedText.size} usable findings for ${input.minimumFootnotes} requested footnotes. Gather more substantive evidence before drafting.`);
  return { ...plan, requiredSourceIds: [...new Set(plan.tasks.flatMap(task => task.assigned.map(fact => fact.sourceId)))] };
}

export async function composePlannedDraft(input: WritingInput, sources: SourceItem[], feedback = "", previous?: EssayDraft, signal?: AbortSignal): Promise<EssayDraft> {
  signal?.throwIfAborted();
  const cacheKey = createHash("sha256").update(JSON.stringify({input,sources})).digest("hex");
  for (const [key, cached] of completedDrafts) if (cached.expires < Date.now()) completedDrafts.delete(key);
  const cached = completedDrafts.get(cacheKey);
  // A provider outage during auditing must not discard completed writing.
  // This is never served as a verified essay: the route still audits it.
  if (!feedback && !previous && cached) return structuredClone(cached.draft);
  const plan = buildWritingPlan(input, sources);
  // Length is checked for the finished essay. A uniform per-paragraph floor
  // previously forced the introduction to be as long as a body paragraph.
  const schema = z.object({ title: z.string(), paragraphs: z.array(z.string().min(120)).length(plan.tasks.length), conclusion: z.string().min(120) });
  let prose: { title: string; paragraphs: string[]; conclusion: string };
  if (input.wordTarget >= 750) {
    // Longer single JSON streams tended to include planning notes and raw
    // source excerpts. Smaller groups keep the completed earlier prose in
    // view while the model develops the next part of the argument.
    prose = await composeInChunks(input, plan, feedback, signal);
  } else try {
    prose = await completeJson({
    system: `Write a complete source-based academic essay from the supplied evidence plan. ${SOURCE_BASED_ARGUMENT_GUIDANCE} Plan the whole argument before writing. Each new paragraph must build on the paragraphs already written without repeating their findings or wording. Each paragraph may use only the findings and source IDs in its own assigned array; save findings assigned to later paragraphs for those paragraphs. Every body paragraph must answer its assigned section point, not summarize the entire essay. Reserve essay-wide synthesis and conclusionBrief solely for the separate conclusion field. The introduction frames the question and thesis briefly; develop detailed examples in the body. Use supplied findings for specialised, research-dependent facts. Basic, widely established knowledge, personal evaluation, and reasoning warranted by established evidence may be uncited. Do not present a new specialised finding or mechanism as common knowledge or inference. Preserve all qualifiers. Paraphrase rather than copy. Answer each section's actual question with a clear subject, concrete evidence and qualified evaluation. Do not replace a section's requested analysis with background from another section. Distinguish potential applications from demonstrated results. Do not invent examples, technical details, mechanisms, costs, policies, study limitations or outcomes. Never reuse an example, variety, statistic, or finding already developed in another paragraph; each paragraph develops different assigned findings. In evaluative or ethical discussion, pair every stated concern with the relevant evidence, limitation, or qualifier from the assigned findings; do not list concerns the findings do not establish. If excerpts do not establish an impact, say only that these excerpts do not establish it; never assert that the underlying research or real world lacks evidence. Do not refer to assigned findings, source figures, the task or the publication's purpose. No grandiose introduction, raw asterisks, em dashes or semicolons. Cite each run of source-dependent facts while composing with [^sourceId], using only that run's supplied source. When a paragraph uses two sources, close the first source's factual run with its footnote before beginning the second; one marker at the end cannot support earlier claims drawn from another work. Do not add decorative citations to common knowledge or personal reasoning. A closing footnote covers previous sentences back to the preceding footnote or paragraph boundary. Meet at least minimumSources distinct works and minimumFootnotes notes using their assigned findings. The requiredSourceIds list identifies available planned evidence, not a requirement to cite every gathered work. More notes and works are allowed. Never put decorative citations on unsupported statements. Write one introduction, all planned sections, then one conclusion. The conclusion contains no citations and only synthesizes established body points, with no new information. Return raw JSON with title, paragraphs (an array of prose strings in plan index order, starting with the introduction), and conclusion (one prose string). The server inserts the section headings.`,
    user: JSON.stringify({ topic: input.topic, instructionText: input.instructionText, extraInstructions: input.extraInstructions,
      wordTarget: input.wordTarget, minimumFootnotes: input.minimumFootnotes, minimumSources: input.minimumSources,
      thesis: plan.thesis, paragraphPlan: plan.tasks.map(task => writerTask(task, plan.headings)), conclusionWords: plan.endWords,
      conclusionBrief: plan.conclusionBrief,
      requiredSourceIds: plan.requiredSourceIds, feedback, previousVerifiedEssay: previousProse(previous),
      revisionRule: "Preserve verified wording. Repair only depleted paragraphs or missing evidence. Cite the specifically required works from their assigned findings. Minimums are floors, not caps." }) + `\n\nOUTPUT FORMAT: Return {"title":"...","paragraphs":[${plan.tasks.map(task => `"paragraph for index ${task.index}"`).join(",")}],"conclusion":"..."}. Exactly ${plan.tasks.length} paragraph strings in the supplied index order. Index 0 is the introduction. The server supplies section headings. Do not output section objects, points or evidence text. Write approximately ${input.wordTarget} words of essay prose, with at least ${Math.max(1, input.wordTarget - 400)} words total. Aim for at least ${Math.ceil((input.wordTarget - 2 * plan.endWords) * 0.8)} words in the body sections together, around ${plan.endWords} words each in the introduction and conclusion. Follow the paragraph word budgets. Do not return a short synopsis. Develop each section paragraph in at least three sentences and 60 words. Write at least 30 words in each of the introduction and conclusion. Use only supported findings and their warranted analysis to reach this length. No new empirical facts may be used as padding.`,
    schema,
    thinking: true, lowEffort: true, reasoningBudget: 512, temperature: 0.4, maxTokens: Math.min(30000, Math.max(8000, input.wordTarget * 8 + 2400)),
    timeoutMs: 90_000,
    tries: 1, parseTries: 2, retryTempDelta: 0, signal,
    validate: prose => {
      prose.paragraphs = prose.paragraphs.map(normalizeCitationMarkers);
      prose.conclusion = normalizeCitationMarkers(prose.conclusion);
      prose.conclusion = prose.conclusion.replace(/\[\^[^\]]+\]/g, "");
      const ids = new Set(prose.paragraphs.flatMap(text => [...text.matchAll(/\[\^(\d+)\]/g)].map(match => Number(match[1]))));
      if ([...ids].some(id => !plan.requiredSourceIds.includes(id))) throw new Error("Use only source IDs supplied in the evidence plan.");
      if (prose.paragraphs.slice(1).some(paragraph => /^\s*(?:conclusion\b|in conclusion\b|to conclude\b|in summary\b)/i.test(paragraph))) {
        throw new Error("A body paragraph reads as the essay's conclusion. Answer its assigned section point there and reserve whole-essay synthesis for the conclusion field.");
      }
      const workById = new Map(sources.map(source => [Number(source.id), workIdentity(source)]));
      const usedWorks = new Set([...ids].map(id => workById.get(id)).filter(Boolean));
      const missing = plan.requiredSourceIds.filter(id => !ids.has(id));
      if (usedWorks.size < (input.minimumSources || 1)) throw new Error(`The essay omitted reserved works ${missing.join(", ")}. Develop and cite enough of their assigned findings to meet the ${input.minimumSources || 1}-work minimum.`);
      const paragraphs = [...prose.paragraphs, prose.conclusion];
      const words = paragraphs.join(" ").replace(/\[\^\d+\]/g, "").split(/\s+/).filter(Boolean).length;
      if (Math.abs(words - input.wordTarget) > 400) throw new Error(`This is a ${words}-word synopsis. Write approximately ${input.wordTarget} words, between ${Math.max(1, input.wordTarget-400)} and ${input.wordTarget+400}. Develop the planned paragraphs from the supplied evidence and qualified analysis.`);
    },
    }, nimChatLong);
  } catch (error) {
    signal?.throwIfAborted();
    if (!isTransportFailure(error)) throw error;
    prose = await composeInChunks(input, plan, feedback, signal);
  }
  prose.paragraphs = prose.paragraphs.map(normalizeCitationMarkers);
  prose.conclusion = normalizeCitationMarkers(prose.conclusion).replace(/\[\^[^\]]+\]/g, "");
  const citedIds = new Set(prose.paragraphs.flatMap(text => [...text.matchAll(/\[\^(\d+)\]/g)].map(match => Number(match[1]))));
  const knownIds = new Set(plan.tasks.flatMap(task => task.assigned.map(finding => finding.sourceId)));
  if ([...citedIds].some(id => !knownIds.has(id))) throw new Error("Use only source IDs supplied in the evidence plan.");
  const citedWorks = new Set(sources.filter(source => citedIds.has(Number(source.id))).map(workIdentity).filter(Boolean));
  if (citedWorks.size < (input.minimumSources || 1)) throw new Error(`The essay cited ${citedWorks.size} distinct works, below the requested ${input.minimumSources || 1}.`);
  const draftedWords = [...prose.paragraphs, prose.conclusion].join(" ").replace(/\[\^\d+\]/g, "").split(/\s+/).filter(Boolean).length;
  if (Math.abs(draftedWords - input.wordTarget) > 400) throw new Error(`The essay is ${draftedWords} words, outside the ${input.wordTarget}-word target tolerance.`);
  const paragraphs = removeRepeatedProse(prose.paragraphs.map(cleanEssayVoice));
  const draft: EssayDraft = { title: prose.title, introduction: [paragraphs[0]],
    sections: plan.headings.map((heading, section) => ({ heading, paragraphs: plan.tasks.filter(task => task.section === section).map(task => paragraphs[task.index]) })),
    conclusion: [prose.conclusion.replace(/\s*—\s*/g, ", ").replace(/;\s*/g, ". ")], footnotes: [], worksCited: [], evidence: [], coverage: [] };
  consolidateSectionParagraphs(draft);
  if (completedDrafts.size >= 20) completedDrafts.delete(completedDrafts.keys().next().value!);
  completedDrafts.set(cacheKey, {expires: Date.now()+5*60_000, draft: structuredClone(draft)});
  return draft;
}

