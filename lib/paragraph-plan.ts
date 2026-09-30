import type { SourceItem } from "./essay-types";
import { splitSentences, normQuote } from "./validate";

const ignored = new Set("about after also between could essay explain discuss evaluate introduction conclusion evidence finding findings source sources paragraph section their these this those through using which with would should topic overview".split(" "));
function terms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z]{4,}/g) || []).map(word => word.replace(/s$/, "").replace(/(?:ory|ion|ing|ed)$/, "")).filter(word => !ignored.has(word)));
}

export interface ParagraphTask {
  index: number; role: string; section: number; words: number;
  point: string; criterion: string; strand: string;
  finding: { sourceId: number; title: string; text: string };
  assigned: Array<{ sourceId: number; title: string; text: string }>;
}

/** Outlines may contain an introduction or conclusion as a named section.
 * The writer already creates those parts, so these are briefs, not body. */
export function structuralSectionRole(heading: string): "introduction" | "conclusion" | null {
  const normalized = heading.trim().replace(/^(?:\d+(?:\.\d+)*|[IVX]+)[.):]?\s+/i, "");
  if (/^introduction\b/i.test(normalized)) return "introduction";
  if (/^(?:conclusion\b|concluding\s+remarks\b|closing\s+remarks\b|final\s+(?:thoughts|reflection|assessment)\b)/i.test(normalized)) return "conclusion";
  return null;
}

export function sourceFindingSentences(content: string): string[] {
  const clean = content.split(/\r?\n/).filter(line => !/^\s*#{1,6}\s|\$\d|you may want to see|explore related products|cookie preferences|all rights reserved/i.test(line)).join("\n");
  return splitSentences(clean).map(text => text.replace(/^[\s*_[\]()#-]+/g, "").trim()).filter(text => {
    const count = text.split(/\s+/).length;
    // Questions on a page are research prompts, not factual findings to cite.
    // Methods boilerplate (search strings, eligibility criteria) concentrates
    // rare terms and outranks real findings in relevance scoring, then leaves
    // the writer with nothing citable. Exclude it at the source.
    if (/\b(search terms?|search strategy|databases? searched|inclusion criteria|exclusion criteria|PRISMA|boolean operators?)\b/i.test(text)) return false;
    if (text.includes("*") && /\bOR\b/.test(text)) return false;
    // Funding, acknowledgment, and disclosure sentences are boilerplate, not
    // evidence: citing grant numbers pads essays with off-topic filler.
    return count >= 6 && count <= 100 && /[.!]["”']?$/.test(text.trim()) &&
      !/\b(?:this|the) (?:abstract|review|article|paper|session|conference) (?:explores|focuses|discusses|examines|reviews|aims|highlights)|\bwe (?:(?:will|also)\s+)*(?:discuss|explore)|\b(?:figure|table)\s+\d+\s+(?:illustrates|shows)|\b(?:this session is important|key highlights include|will be discussed)\b|creative commons|subscribe|sign up|distributed under the terms/i.test(text) &&
      !/\b(funded (?:in part )?by|funding (?:was|were|received|provided)|grants? (?:no\.?|numbers?|r\d\w+)|acknowledg|conflicts? of interest|competing interests?|ethics (?:approval|committee)|institutional review board|written informed consent)\b/i.test(text);
  });
}

/** Relevance remains decisive, but broad listing/marketing pages should not
 * outrank a comparable original study or public-agency page by keyword count. */
export function sourceQualityFactor(source: SourceItem): number {
  let host = "";
  let path = "";
  try { const url = new URL(source.url); host = url.hostname.toLowerCase(); path = url.pathname.toLowerCase(); } catch { /* unknown host */ }
  let factor = source.kind === "primary" || /\.gov$/.test(host) ? 1.3
    : source.kind === "academic" || /\.edu$|(?:frontiersin\.org|springer\.com|sciencedirect\.com|plos\.org|wiley\.com|nature\.com)$/.test(host) ? 1.18
    : 1;
  if (/(?:^|\/)(?:category|tag|topics|search)(?:\/|$)/.test(path)) factor *= 0.6;
  // Study-format pages rank below substantive pages, detected by URL and
  // title format rather than by site name.
  const title = (source.title || "").toLowerCase();
  if (/\/(notes?|study-guides?|study_guides?|key-terms?|key_terms?|flashcards?|homework-help?|past-papers?|practice-questions?)\//.test(path) ||
    /\b(flashcards?|study guides?|key terms?|homework help|past papers?|practice questions?|revision notes?)\b/.test(title)) factor *= 0.6;
  return factor;
}

/** Plan arguments from outline points, then allocate observed evidence.
 * Citation IDs and page identity stay unchanged. A shared text ledger stops
 * alternate page representations from supplying the same finding again. */
export function planParagraphs(input: {
  topic: string; wordTarget: number; structureJson: string;
  minimumFootnotes?: number; minimumSources?: number; maxAssignedFindings?: number;
}, sources: SourceItem[]) {
  const outline = JSON.parse(input.structureJson) as {
    thesis?: string; sections?: Array<{ heading?: string; paragraphs?: Array<{ point?: string; criterion?: string; strand?: string }> }>;
  };
  const introSections = outline.sections?.filter(section => structuralSectionRole(section.heading || "") === "introduction") || [];
  const conclusionSections = outline.sections?.filter(section => structuralSectionRole(section.heading || "") === "conclusion") || [];
  const bodySections = outline.sections?.filter(section => !structuralSectionRole(section.heading || ""))
    .map(section => ({...section, paragraphs: section.paragraphs ? [...section.paragraphs] : undefined})) || [];
  let closingJudgment = "";
  if (bodySections.length > 1) {
    const last = bodySections[bodySections.length - 1];
    const points = last.paragraphs || [];
    const finalPoint = points.at(-1)?.point || "";
    if (points.length > 1 && /\b(?:overall|synthesi[sz]e|reasoned judgment|final judgment|balance .+ against .+)\b/i.test(finalPoint)) {
      closingJudgment = finalPoint;
      last.paragraphs = points.slice(0, -1);
    }
  }
  const sections: Array<{heading?: string; paragraphs?: Array<{point?: string; criterion?: string; strand?: string}>}> =
    bodySections.length ? bodySections : [{ heading: "Discussion", paragraphs: [{point: input.topic}] }];
  const introductionBrief = introSections.flatMap(section => section.paragraphs?.map(paragraph => paragraph.point).filter(Boolean) || []).join(" ");
  const conclusionBrief = [...conclusionSections.flatMap(section => section.paragraphs?.map(paragraph => paragraph.point).filter(Boolean) || []), closingJudgment].filter(Boolean).join(" ");
  const headings = sections.map(section => section.heading || "Discussion");
  const points = sections.map(section => section.paragraphs?.length ? section.paragraphs : [{ point: section.heading || input.topic }]);
  const topicTerms = terms(input.topic);
  const sectionFocus = headings.map((heading, index) => new Set(
    [...terms(`${heading} ${points[index].map(point => point.point || "").join(" ")}`)]
      .filter(token => !topicTerms.has(token))));
  const count = Math.max(headings.length,
    input.wordTarget >= 650 && headings.length === 2 ? 4 : 1,
    Math.round(input.wordTarget / 150) - 2 - Number(Boolean(closingJudgment)),
    (input.minimumSources || 1) - 1, (input.minimumFootnotes || 1) - 1, 1);
  const endWords = Math.max(35, Math.min(120, Math.round(input.wordTarget / 8)));
  // Budgets run above the nominal share: writers under-write to roughly
  // two-thirds of budget, and the ±400-word tolerance absorbs overshoot.
  const bodyWords = Math.max(75, Math.round(((input.wordTarget - 2 * endWords) / count) * 1.25));
  const bank = sources.flatMap(source => sourceFindingSentences(source.content)
    .map(text => ({ sourceId: Number(source.id), title: source.title, text, tokens: terms(text), key: normQuote(text), quality: sourceQualityFactor(source) })));
  if (!bank.length) throw new Error("The selected pages contain no substantive findings. Gather sources again.");
  const frequency = new Map<string, number>();
  for (const finding of bank) for (const token of finding.tokens) frequency.set(token, (frequency.get(token) || 0) + 1);
  const overlap = (tokens: Set<string>, wanted: Set<string>) => [...wanted].reduce((score, token) => score + (tokens.has(token) ? Math.log(1 + bank.length / (frequency.get(token) || 1)) : 0), 0);
  const used = new Set<string>();
  const works = new Set<number>();
  // At ordinary essay lengths, give each major question room for evidence
  // and analysis before allocating extra paragraphs by outline detail.
  const allocations = headings.map(() => count >= headings.length * 2 ? 2 : 1);
  for (let i = allocations.reduce((sum, value) => sum + value, 0); i < count; i++) {
    // Spread the word budget in proportion to the actual outline points.
    const section = allocations.reduce((best, n, index) => {
      const share = n / points[index].length;
      const bestShare = allocations[best] / points[best].length;
      return share < bestShare || (share === bestShare && n < allocations[best]) ? index : best;
    }, 0);
    allocations[section]++;
  }
  const jobs = allocations.flatMap((n, section) => Array.from({ length: n }, (_, position) => {
    // If the word budget needs fewer paragraphs than the outline has points,
    // combine adjacent points instead of silently discarding them.
    const start = Math.floor(position * points[section].length / n);
    const stop = Math.max(start + 1, Math.floor((position + 1) * points[section].length / n));
    const selected = points[section].slice(Math.min(start, points[section].length - 1), stop);
    return { section, point: selected.map(p => p.point || headings[section]).join(" "),
      criterion: [...new Set(selected.map(p => p.criterion || "").filter(Boolean))].join(", "),
      strand: [...new Set(selected.map(p => p.strand || "").filter(Boolean))].join(", ") };
  }));
  const assign = (point: string, section: number, words: number, introduction = false) => {
    const focus = terms(introduction ? input.topic : `${headings[section]} ${point}`);
    // Broad topic words must not outweigh the paragraph's specific purpose.
    const specific = new Set([...focus].filter(token => !topicTerms.has(token)));
    const ranked = bank.map(finding => ({ ...finding,
      score: (overlap(finding.tokens, specific) * 4 + overlap(finding.tokens, focus) + overlap(finding.tokens, topicTerms) * 0.15) * finding.quality
        * (section < 0 ? 1 : (() => {
          const here = overlap(finding.tokens, sectionFocus[section]);
          const elsewhere = Math.max(0, ...sectionFocus.filter((_, index) => index !== section)
            .map(words => overlap(finding.tokens, words)));
          return elsewhere > here * 1.2 && elsewhere > 0 ? 0.35 : 1;
        })()),
    })).sort((a, b) => b.score - a.score || Number(used.has(a.key)) - Number(used.has(b.key)));
    const best = ranked[0];
    const relevant = ranked.filter(f => f.score >= best.score * 0.55);
    const fresh = relevant.filter(f => !used.has(f.key));
    // Diversity is a tie-break among relevant candidates, rather than a
    // license to place an unrelated work under a heading to fill a quota.
    const first = (!introduction
      ? fresh.find(f => !works.has(f.sourceId) && f.score >= best.score * (works.size < (input.minimumSources || 1) ? 0.7 : 0.8))
      : undefined) || fresh[0] || best;
    const available = relevant.filter(f => (input.maxAssignedFindings ? true : f.sourceId === first.sourceId) && !used.has(f.key));
    const assigned: ParagraphTask["assigned"] = [];
    let evidenceWords = 0;
    const limit = input.maxAssignedFindings || Number.MAX_SAFE_INTEGER;
    const selected = new Set<string>();
    const pool = available.length ? available : [first];
    while (assigned.length < limit && pool.some(finding => !selected.has(finding.key))) {
      // A second independent finding gives the writer something concrete to
      // develop when one short excerpt cannot sustain a full paragraph.
      const finding = !assigned.length ? first : pool.filter(item => !selected.has(item.key))
        .sort((a, b) => {
          const score = (item: typeof a) => item.score
            * (assigned.some(existing => existing.sourceId === item.sourceId) ? 0.72 : 1)
            * (assigned.some(existing => normQuote(existing.text) === item.key) ? 0 : 1);
          return score(b) - score(a);
        })[0];
      if (!finding || selected.has(finding.key)) break;
      selected.add(finding.key);
      // Do not append a generic introduction to an otherwise focused point.
      if (assigned.length && specific.size && finding.score < first.score * 0.55) continue;
      assigned.push({ sourceId: finding.sourceId, title: finding.title, text: finding.text });
      used.add(finding.key);
      evidenceWords += finding.text.split(/\s+/).length;
      // An introduction frames the argument; supplying several overview
      // findings encourages the model to repeat the same benefits up front.
      if (introduction && input.maxAssignedFindings) break;
      if (input.maxAssignedFindings
        ? assigned.length >= 2 && evidenceWords >= words * 0.8
        : evidenceWords >= words * 1.2) break;
    }
    for (const finding of assigned) works.add(finding.sourceId);
    return { finding: assigned[0], assigned };
  };
  // Reserve section-specific material before choosing the introductory
  // overview. The introduction must not consume the essay's best examples.
  const body: ParagraphTask[] = [];
  jobs.forEach((job, index) => {
    const earlier = body.filter(task => task.section === job.section);
    const judgment = /reasoned judgment|overall (?:assessment|evaluation)|synthesi[sz]/i.test(job.point);
    // An evaluative conclusion within a section must assess its established
    // evidence, rather than drag in an unrelated unused article.
    const evidence = judgment && earlier.length
      ? { finding: earlier[0].finding, assigned: [earlier[0].finding] }
      : assign(job.point, job.section, bodyWords);
    body.push({ ...job, index: index + 1, role: judgment && earlier.length ? "judgment" : "body", words: bodyWords, ...evidence });
  });
  const weights = body.map(task => Math.sqrt(task.assigned.reduce((n, fact) => n + fact.text.split(/\s+/).length, 0)));
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  // Writers under-write to roughly two-thirds of budget; plan 25% above the
  // nominal target so verified essays land near it. The ±400-word tolerance
  // absorbs overshoot, and per-paragraph minima hold the floor.
  const extraWords = Math.max(0, Math.round(input.wordTarget * 1.25) - endWords * 2 - body.length * 60);
  body.forEach((task, index) => { task.words = 60 + Math.round(extraWords * weights[index] / weightTotal); });
  const intro = { index: 0, role: "introduction", section: -1, words: endWords,
    point: [outline.thesis || input.topic, introductionBrief].filter(Boolean).join(" "), criterion: "", strand: "", ...assign(outline.thesis || input.topic, -1, endWords, true) };
  return { tasks: [intro, ...body] as ParagraphTask[], headings, endWords, thesis: outline.thesis || input.topic, conclusionBrief };
}
