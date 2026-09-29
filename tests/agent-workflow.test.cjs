const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanSourceTitle, qualityWeight } = require('../lib/search.ts');
const { assertHeadingNamesCovered } = require('../lib/validate.ts');
const { cleanEssayVoice } = require('../lib/source-writer.ts');

test('search titles strip PDF prefixes and shouting caps (Malthus sample)', () => {
  assert.equal(
    cleanSourceTitle('(PDF) A CRITICAL ANALYSIS OF MULTHUSIAN THEORY ....'),
    'A critical analysis of multhusian theory'
  );
  assert.equal(cleanSourceTitle('Malthusian Theory | Varsity Tutors'), 'Malthusian Theory | Varsity Tutors');
});

test('study-guide hosts rank below substantive pages', () => {
  const guide = { title: 'x', url: 'https://www.tutorchase.com/notes/x', snippet: '', publisher: 'tutorchase.com', date: '', score: 1.0, query: 'q' };
  const journal = { title: 'y', url: 'https://www.nature.com/articles/y', snippet: '', publisher: 'nature.com', date: '', score: 1.0, query: 'q' };
  assert.ok(qualityWeight(journal) > qualityWeight(guide));
});

test('heading names must be covered in their section (Simon rule)', () => {
  const draft = {
    title: 't', introduction: ['i'], conclusion: ['c'], footnotes: [], worksCited: [], evidence: [], coverage: [],
    sections: [{ heading: 'Alternative Theories: Boserup, Simon, and Ingenuity', paragraphs: ['Boserup argued pressure prompts innovation.'] }],
  };
  assert.throws(() => assertHeadingNamesCovered(draft), /Simon/);
  draft.sections[0].paragraphs = ['Boserup argued pressure prompts innovation. Simon countered that ingenuity outruns scarcity.'];
  assertHeadingNamesCovered(draft);
});

test('essay voice clears audit typographic fallout', () => {
  assert.equal(cleanEssayVoice('Its claims hold .  Malthus argued growth strains food.[^1]'), 'Its claims hold. Malthus argued growth strains food.[^1]');
});
