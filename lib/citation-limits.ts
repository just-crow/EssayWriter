import type { EssayDraft } from "./essay-types";
import { workIdentity } from "./work-identity";

export function assertUncitedConclusion(draft: EssayDraft) {
  if (draft.conclusion.some(paragraph => /\[\^[^\]]+\]/.test(paragraph))) throw new Error("The conclusion must contain no citations. Restate the thesis and synthesize only points already established in the introduction and body, without new information.");
}

export function citationCounts(draft: EssayDraft) {
  const notes = new Map(draft.footnotes.map((note) => [note.id, workIdentity(note)]));
  const works = new Set<string>();
  let footnotes = 0;
  for (const paragraph of [...draft.introduction, ...draft.sections.flatMap((section) => section.paragraphs), ...draft.conclusion]) {
    for (const match of paragraph.matchAll(/\[\^(\d+)\]/g)) {
      const url = notes.get(Number(match[1]));
      if (url) { footnotes++; works.add(url); }
    }
  }
  return { footnotes, works: works.size };
}

export function assertCitationMinimums(draft: EssayDraft, minimumFootnotes: number, minimumSources: number) {
  const counts = citationCounts(draft);
  if (counts.footnotes < minimumFootnotes || counts.works < minimumSources) {
    throw new Error(`The verified essay has ${counts.footnotes} footnotes from ${counts.works} distinct works. At least ${minimumFootnotes} footnotes and ${minimumSources} distinct works are required. Develop additional factual findings from genuine source text and cite them while writing. Repeated citations to one work do not meet the distinct-works minimum. Never add unsupported claims or decorative citations to meet a quota.`);
  }
}
