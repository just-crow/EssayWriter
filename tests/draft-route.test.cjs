const { test } = require('node:test');
const assert = require('node:assert/strict');
const nim = require('../lib/nim.ts');
const { POST } = require('../app/api/draft/route.ts');

const S1 = 'Green roofs reduce building energy use and support city biodiversity in dense neighborhoods. The study tracked these outcomes across two summers of observation.';
const S2 = 'Green walls reduce building energy use and support city biodiversity in dense neighborhoods. Researchers recorded lower wall temperatures behind planted facades.';

function source(id, title, url, content) {
  return { id: String(id), author: '', title, container: '', publisher: 'example.org', year: '2024', url, accessed: '1 Oct 2026', supports: 'test', kind: 'web', content };
}

const OUTLINE = {
  thesis: 'Green roofs should be evaluated for city health.',
  sections: [{ heading: 'Green Roof Energy Benefits', paragraphs: [{ point: 'Explain green roof energy benefits with evidence.', criterion: '', strand: '' }] }],
  checklist: [],
};

// Every sentence shares vocabulary with both source passages so the real
// lexical verification gate passes; markers always cite required IDs.
function citedBlock(id, variant) {
  const finding = variant === 0
    ? `Green roofs reduce building energy use and support city biodiversity in dense neighborhoods.[^${id}]`
    : `Green walls reduce building energy use and support city biodiversity in dense neighborhoods.[^${id}]`;
  return `${finding} These green roof findings support building energy planning in dense neighborhoods.[^${id}] Dense neighborhoods with green roofs support biodiversity while reducing building energy use.[^${id}]`;
}

test('below-minimum essays are delivered with warnings, not discarded', async () => {
  const original = nim.nimChatLong;
  nim.nimChatLong = async (params) => {
    const system = params.system;
    const user = params.user;
    if (system.includes('CONCLUSION CHECK')) {
      const batch = JSON.parse(user.split('ESSAY PARAGRAPHS AND SENTENCES:\n')[1].split('\n\nReturn')[0]);
      return JSON.stringify({ claims: batch.flatMap((p) => p.sentences.map((s) => ({ paragraph: p.paragraph, sentenceIndex: s.sentenceIndex, status: 'logical_inference', onTopic: true, reason: 'Synthesis.' }))) });
    }
    if (system.includes('source-grounding auditor')) {
      const batch = JSON.parse(user.split('ESSAY PARAGRAPHS AND SENTENCES:\n')[1].split('\n\nReturn')[0]);
      return JSON.stringify({ claims: batch.flatMap((p) => p.sentences.map((s) => ({ paragraph: p.paragraph, sentenceIndex: s.sentenceIndex, status: 'supported', onTopic: true, supportingSourceIndex: 0, supportingPassageIndexes: [0], reason: 'Directly stated.' }))) });
    }
    if (system.includes('checking relevance')) {
      const items = JSON.parse(user.split('SENTENCES TO CHECK: ')[1].split('\nReturn')[0]);
      return JSON.stringify({ decisions: items.flatMap((it) => it.sentences.map((s) => ({ paragraph: it.paragraph, sentenceIndex: s.sentenceIndex, relevant: true, reason: 'On point.' }))) });
    }
    if (system.includes('Extend the supplied') || system.includes('Extend an existing')) {
      const ids = [...user.matchAll(/"sourceId":(\d+)/g)].map((m) => Number(m[1]));
      const texts = [...user.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
      const seen = new Set();
      const slots = [];
      for (let i = 0; i < ids.length && slots.length < texts.length; i++) {
        if (seen.has(`${ids[i]}:${texts[i]}`)) continue;
        seen.add(`${ids[i]}:${texts[i]}`);
        slots.push({ id: ids[i], text: texts[i] });
      }
      return JSON.stringify({ additions: slots.map((s) => `${s.text} Further green roof analysis here.[^${s.id}]`) });
    }
    if (system.includes('complete source-based academic essay')) {
      const reqIds = [...user.matchAll(/"requiredSourceIds":\[([^\]]*)\]/g)].flatMap((m) => m[1].split(',').map((s) => Number(s)).filter((n) => n > 0));
      const id = reqIds[0] || 1;
      const nBody = (user.match(/"role":"body"/g) || []).length;
      const bodies = Array.from({ length: nBody }, (_, i) => citedBlock(id, i % 2));
      const intro = `Green roofs reduce building energy use in dense neighborhoods.[^${id}] This essay evaluates these green roof energy findings.`;
      const conclusion = `Green roofs merit attention for dense neighborhoods across many districts. Cities should weigh costs and upkeep alongside benefits before committing funds.`;
      return JSON.stringify({ title: 'Test Essay', paragraphs: [intro, ...bodies], conclusion });
    }
    throw new Error(`Unexpected model call: ${system.slice(0, 80)}`);
  };
  try {
    const res = await POST(new Request('http://localhost/api/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: 'Green roofs and city health',
        instructionText: '',
        extraInstructions: '',
        wordTarget: 400,
        minimumFootnotes: 12,
        minimumSources: 2,
        structureJson: JSON.stringify(OUTLINE),
        sourcesJson: JSON.stringify([
          source(1, 'Green roof study', 'https://example.org/roofs', S1),
          source(2, 'Green wall study', 'https://example.org/walls', S2),
        ]),
        projectId: null,
      }),
    }));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.issues.some((issue) => issue.code === 'BELOW_MINIMUMS'), 'shortfall must warn, not fail');
    assert.ok(data.wordCount > 0);
    assert.ok(data.draft.footnotes.length >= 1, 'delivers what verified');
    assert.ok(data.draft.footnotes.length < 12, 'warning is honest about the shortfall');
  } finally {
    nim.nimChatLong = original;
  }
});
