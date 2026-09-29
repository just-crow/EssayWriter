/** Number actual page passages so models can reference evidence without
 * reproducing long quotations. Every passage is a span of the supplied text. */
export function sourcePassages(content: string): string[] {
  const passages: string[] = [];
  for (const block of content.split(/\n+/).map((text) => text.trim()).filter(Boolean)) {
    if (block.length < 40 || block.split(/\s+/).length < 6) continue;
    if (/^#{1,6}\s|interested in deep dives|subscribe|sign up|cookie preferences|all rights reserved|contact us|advertisement/i.test(block)) continue;
    let start = 0;
    while (start < block.length) {
      let end = Math.min(start + 1200, block.length);
      if (end < block.length) {
        const space = block.lastIndexOf(" ", end);
        if (space > start + 600) end = space;
      }
      const passage = block.slice(start, end).trim();
      if (passage.length >= 20) passages.push(passage);
      start = end;
    }
  }
  return passages;
}

/** Search the entire stored page, rather than retaining only its beginning.
 * Keep original passage indexes so verification still anchors to page text. */
export function relevantSourcePassages<T extends {passageIndex: number; text: string}>(passages: T[], claims: string[], maxChars: number): T[] {
  if (passages.reduce((sum, passage) => sum + passage.text.length, 0) <= maxChars) return passages;
  const stop = new Set("that this with from have were been their they which these those into such also more than only when where will would could should source study studies".split(" "));
  const words = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) || []).map(word => word.replace(/s$/, "")).filter(word => !stop.has(word)));
  const queries = claims.map(words);
  const passageWords = passages.map(passage => words(passage.text));
  const frequencies = new Map<string, number>();
  for (const tokens of passageWords) for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
  const score = (index: number, query: Set<string>) => [...query].reduce((total, word) => total + (passageWords[index].has(word) ? Math.log(1 + passages.length / (frequencies.get(word) || 1)) : 0), 0);
  const selected = new Set<number>();
  let chars = 0;
  const add = (index: number) => {
    if (selected.has(index) || chars + passages[index].text.length > maxChars) return;
    selected.add(index); chars += passages[index].text.length;
  };
  // Each cited sentence gets its own candidate before aggregate ranking.
  for (const query of queries) {
    const ranked = passages.map((_, index) => ({index, score: score(index, query)})).sort((a, b) => b.score - a.score);
    if (ranked[0]?.score > 0) add(ranked[0].index);
  }
  const ranked = passages.map((_, index) => ({index, score: Math.max(0, ...queries.map(query => score(index, query)))})).sort((a, b) => b.score - a.score);
  for (const candidate of ranked) if (candidate.score > 0) add(candidate.index);
  // Include adjacent context when space permits, preserving qualifications.
  for (const index of [...selected]) for (const neighbor of [index - 1, index + 1]) if (passages[neighbor]) add(neighbor);
  if (!selected.size && passages.length) add(0);
  return passages.filter((_, index) => selected.has(index));
}
