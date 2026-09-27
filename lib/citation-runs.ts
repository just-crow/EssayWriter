import type { EssayDraft } from "./essay-types";
import { normalizeUrl } from "./search";
import { expandFootnoteUses, pruneOrphanFootnotes, rebuildWorksCited, splitSentences } from "./validate";

/** A footnote closes a run of preceding sentences, back to the previous
 * footnote or paragraph boundary. Trailing uncited text gets no source. */
export function citationScopes(text: string) {
  const sentences = splitSentences(text);
  let ids: number[] = [];
  return sentences.map(sentence => ({ sentence, ids: [] as number[] })).reverse().map(item => {
    const explicit = [...item.sentence.matchAll(/\[\^(\d+)\]/g)].map(match => Number(match[1]));
    if (explicit.length) ids = explicit;
    return { sentence: item.sentence, ids: [...ids] };
  }).reverse();
}

/** Compact verified consecutive sentences from the same work. Keep every
 * evidence anchor, remapping it to the single footnote closing that run. */
export function groupCitationRuns(draft: EssayDraft): void {
  const notes = new Map(draft.footnotes.map(note => [note.id, note]));
  const remap = new Map<string, number>();
  let paragraph = 0;
  const rewrite = (text: string) => {
    const current = paragraph++;
    const output: string[] = [];
    let run: Array<{ text: string; id: number }> = [];
    let url = "";
    const flush = () => {
      if (!run.length) return;
      const lastId = run.at(-1)!.id;
      for (const item of run) remap.set(`${current}:${item.id}`, lastId);
      output.push(`${run.map(item => item.text.replace(/\[\^\d+\]/g, "").trim()).join(" ")}[^${lastId}]`);
      run = []; url = "";
    };
    for (const sentence of splitSentences(text)) {
      const ids = [...sentence.matchAll(/\[\^(\d+)\]/g)].map(match => Number(match[1]));
      const nextUrl = ids.length === 1 ? normalizeUrl(notes.get(ids[0])?.url || "") : "";
      if (!nextUrl) {
        flush(); output.push(sentence);
        for (const id of ids) remap.set(`${current}:${id}`, id);
        continue;
      }
      if (url && url !== nextUrl) flush();
      url = nextUrl; run.push({ text: sentence, id: ids[0] });
    }
    flush();
    return output.join(" ");
  };
  draft.introduction = draft.introduction.map(rewrite);
  for (const section of draft.sections) section.paragraphs = section.paragraphs.map(rewrite);
  draft.conclusion = draft.conclusion.map(rewrite);
  draft.evidence = draft.evidence.map(item => ({ ...item, source: remap.get(`${item.paragraph}:${item.source}`) ?? item.source }));
  pruneOrphanFootnotes(draft);
  expandFootnoteUses(draft);
  rebuildWorksCited(draft);
}
