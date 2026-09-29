const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanSourceTitle, qualityWeight } = require('../lib/search.ts');
const { assertHeadingNamesCovered } = require('../lib/validate.ts');
const { cleanEssayVoice } = require('../lib/source-writer.ts');

test('search titles strip file-dump prefixes and shouting caps', () => {
  assert.equal(
    cleanSourceTitle('(PDF) A CRITICAL ANALYSIS OF RIVER BASINS ....'),
    'A critical analysis of river basins'
  );
  assert.equal(cleanSourceTitle('River Basins and Flood Control'), 'River Basins and Flood Control');
});

test('study-format pages rank below substantive pages on equal footing', () => {
  const base = { snippet: '', publisher: 'example.com', date: '', score: 1.0, query: 'q' };
  const guide = { ...base, title: 'River Basins Flashcards', url: 'https://example.com/study-guides/river-basins' };
  const article = { ...base, title: 'River Basins and Flood Control', url: 'https://example.com/articles/river-basins' };
  assert.ok(qualityWeight(article) > qualityWeight(guide));
});

test('heading promises must be covered in their section', () => {
  const draft = {
    title: 't', introduction: ['i'], conclusion: ['c'], footnotes: [], worksCited: [], evidence: [], coverage: [],
    sections: [{ heading: 'Contrasting Views: Smith, Jones, and Adaptation', paragraphs: ['Smith presents one view of adaptation.'] }],
  };
  assert.throws(() => assertHeadingNamesCovered(draft), /Jones/);
  draft.sections[0].paragraphs = ['Smith presents one view of adaptation. Jones counters that adaptation fails under scarcity.'];
  assertHeadingNamesCovered(draft);
});

test('essay voice clears audit typographic fallout', () => {
  assert.equal(cleanEssayVoice('Its claims hold .  Rivers shaped the valley.[^1]'), 'Its claims hold. Rivers shaped the valley.[^1]');
});
