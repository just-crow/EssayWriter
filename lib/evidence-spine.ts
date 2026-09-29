import type { SourceItem } from "./essay-types";
import { normalizeUrl } from "./search";
import { normQuote, splitSentences } from "./validate";

/** Concrete source findings selected BEFORE prose is written. */
export function evidenceSpine(selected: SourceItem[], originals: SourceItem[], limit = 12, minimumSources = 1, structureJson?: string): string {
  limit = Math.max(limit, minimumSources);
  const ranked = selected.map((source) => {
    const original = originals.filter((item) => normalizeUrl(item.url) === normalizeUrl(source.url)).map((item) => normQuote(item.content));
    const sentences = splitSentences(source.content).filter((sentence) => {
      const words = sentence.split(/\s+/).length;
      return words >= 6 && words <= 100 && /[.!?]$/.test(sentence.trim()) &&
        original.some((text) => text.includes(normQuote(sentence))) &&
        !/subscribe|cookie preferences|sign up|click here|all rights reserved|catalog lists|enrollment options|this presentation|this section|this chapter|creative commons|open access article|distributed under the terms|conflicts of interest|data availability|\b(?:this|the) (?:abstract|review|article|paper) (?:explores|focuses|discusses|examines|reviews|aims)|\bit will (?:also )?outline/i.test(sentence);
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
  if (structureJson) {
    const outline = JSON.parse(structureJson) as { sections?: Array<{ heading?: string; paragraphs?: Array<{ point?: string }> }> };
    const tokens = (text: string) => new Set((text.toLowerCase().match(/[a-z]{4,}/g) || []).map(word => word.replace(/s$/, "")));
    const focus = (outline.sections || []).map(section => tokens(`${section.heading || ""} ${(section.paragraphs || []).map(p => p.point || "").join(" ")}`));
    const common = new Set([...new Set(focus.flatMap(set => [...set]))].filter(token => focus.filter(set => set.has(token)).length > Math.max(1, focus.length / 2)));
    const score = (text: string, wanted: Set<string>) => [...tokens(text)].filter(token => wanted.has(token)).reduce((n, token) => n + (common.has(token) ? 0.1 : 1), 0);
    const all = pool.flatMap(item => item.sentences.map(text => ({ sourceId: item.source.id, text })));
    const used = new Set<string>();
    const add = (fact: typeof facts[number]) => {
      const key = `${fact.sourceId}:${normQuote(fact.text)}`;
      if (used.has(key) || facts.length >= limit) return;
      used.add(key); facts.push(fact);
    };
    // Preserve selectable works, but choose their useful statements rather
    // than blindly starting with every paper's generic abstract.
    for (const item of pool) {
      const text = [...item.sentences].sort((a, b) => Math.max(0, ...focus.map(set => score(b, set))) - Math.max(0, ...focus.map(set => score(a, set))))[0];
      add({ sourceId: item.source.id, text });
    }
    const perSection = Math.max(1, Math.floor((limit - facts.length) / Math.max(1, focus.length)));
    for (const wanted of focus) {
      for (const fact of [...all].sort((a, b) => score(b.text, wanted) - score(a.text, wanted)).filter(f => score(f.text, wanted) > 0).slice(0, perSection)) add(fact);
    }
    for (const fact of all) add(fact);
    return JSON.stringify(facts);
  }
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
