import type { SourceItem } from "./essay-types";
import { normalizeUrl } from "./search";
import { normQuote, splitSentences } from "./validate";

/** Concrete source findings selected BEFORE prose is written. */
export function evidenceSpine(selected: SourceItem[], originals: SourceItem[], limit = 12, minimumSources = 1): string {
  limit = Math.max(limit, minimumSources);
  const ranked = selected.map((source) => {
    const original = originals.filter((item) => normalizeUrl(item.url) === normalizeUrl(source.url)).map((item) => normQuote(item.content));
    const sentences = splitSentences(source.content).filter((sentence) => {
      const words = sentence.split(/\s+/).length;
      return words >= 6 && words <= 100 && /[.!?]$/.test(sentence.trim()) &&
        original.some((text) => text.includes(normQuote(sentence))) &&
        !/subscribe|cookie preferences|sign up|click here|all rights reserved|catalog lists|enrollment options|this presentation|this section|this chapter/i.test(sentence);
    });
    const primary = /\.edu(?:\/|$)|csed\.acm\.org|\.gov(?:\/|$)/i.test(source.url) ? 2 : 0;
    return { source, sentences, primary };
  }).filter((item) => item.sentences.length).sort((a, b) => b.primary - a.primary);
  const seen = new Set<string>();
  const uniqueRanked = ranked.filter((item) => {
    const url = normalizeUrl(item.source.url);
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
  // Primary domains get priority, but must not exclude relevant educational
  // works hosted on .org/.net (for example biology textbooks and Khan Academy).
  const pool = uniqueRanked;
  const facts: Array<{ sourceId: string; text: string }> = [];
  for (let sentenceIndex = 0; facts.length < limit; sentenceIndex++) {
    let added = false;
    for (const item of pool) {
      if (item.sentences[sentenceIndex] && facts.length < limit) {
        facts.push({ sourceId: item.source.id, text: item.sentences[sentenceIndex] });
        added = true;
      }
    }
    if (!added) break;
  }
  return JSON.stringify(facts);
}
