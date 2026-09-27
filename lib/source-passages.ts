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
