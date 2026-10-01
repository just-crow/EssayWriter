const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  splitPastedMaterial,
  needsNewSources,
  normalizeVerbatimTarget,
  resolveVerbatimTarget,
  placeVerbatim,
  userSentenceSet,
  missingVerbatim,
  dropDanglingMarkers,
  cutAtWord,
} = require('../lib/refine-intent.ts');

const PROSE =
  'Cities should invest in green spaces to improve public health because vegetation supports physical activity and social cohesion across neighborhoods. ' +
  'Evidence links tree-lined streets with lower stress and better air quality for nearby residents in dense districts. ' +
  'However, access remains uneven, and rising property values can displace the very communities that would benefit most from new parks. ' +
  'Targeted planning with maintenance funding offers the most defensible path forward for municipal governments today.';

test('fenced blocks split as pasted material', () => {
  const { directives, pasted } = splitPastedMaterial('Replace the intro with this:\n```\n' + PROSE + '\n```');
  assert.match(directives, /Replace the intro/);
  assert.ok(pasted.includes('Targeted planning'));
  assert.ok(!directives.includes('Targeted planning'));
});

test('trailing prose after a directive colon splits out', () => {
  const { directives, pasted } = splitPastedMaterial(
    'I rewrote the opening, just replace it and keep the footnotes consistent: ' + PROSE
  );
  assert.match(directives, /keep the footnotes consistent/);
  assert.ok(pasted.startsWith('Cities should invest'));
});

test('ordinary long messages without placement cues stay whole', () => {
  const msg = 'Note: the essay discusses green infrastructure at length. It covers physical activity benefits for residents across many neighborhoods. It also addresses funding gaps and maintenance needs in detail over several sections.';
  const { directives, pasted } = splitPastedMaterial(msg);
  assert.equal(pasted, '');
  assert.equal(directives, msg);
});

test('short directives never split', () => {
  const { directives, pasted } = splitPastedMaterial('Shorten the conclusion.');
  assert.equal(pasted, '');
  assert.equal(directives, 'Shorten the conclusion.');
});

test('source fetching follows task need, not habit', () => {
  assert.equal(needsNewSources('Replace the intro', true), false);
  assert.equal(needsNewSources('Use this text as written', true), false);
  assert.equal(needsNewSources('Shorten the essay', false), false);
  assert.equal(needsNewSources('Add a paragraph on water quality', false), true);
  assert.equal(needsNewSources('Evaluate the whole argument', false), true);
  assert.equal(needsNewSources('', true), false);
  assert.equal(needsNewSources('', false), true);
});

test('explicit targets normalize regardless of case', () => {
  assert.equal(normalizeVerbatimTarget('Conclusion'), 'conclusion');
  assert.equal(normalizeVerbatimTarget('INTRODUCTION'), 'introduction');
  assert.equal(normalizeVerbatimTarget('Costs and Trade-offs'), 'Costs and Trade-offs');
  assert.equal(normalizeVerbatimTarget(''), '');
});

test('verbatim targets resolve to essay locations', () => {
  const headings = ['Benefits', 'Costs and Trade-offs'];
  assert.equal(resolveVerbatimTarget('introduction', '', headings), 'introduction');
  assert.equal(resolveVerbatimTarget('Costs', '', headings), 'Costs and Trade-offs');
  assert.equal(resolveVerbatimTarget('', 'rewrite the first part please', headings), 'introduction');
  assert.equal(resolveVerbatimTarget('', 'fix the conclusion now', headings), 'conclusion');
  assert.equal(resolveVerbatimTarget('', 'tighten the prose', headings), null);
});

test('mechanical placement replaces only the target', () => {
  const draft = {
    introduction: ['Old intro.'],
    sections: [{ heading: 'Benefits', paragraphs: ['Old body.'] }],
    conclusion: ['Old end.'],
  };
  const placed = placeVerbatim(draft, 'Benefits', 'New one.\n\nNew two.');
  assert.equal(placed.applied, true);
  assert.equal(placed.part, 'section');
  assert.equal(placed.sectionIndex, 0);
  assert.deepEqual(draft.sections[0].paragraphs, ['New one.', 'New two.']);
  assert.deepEqual(draft.introduction, ['Old intro.']);
  assert.equal(placeVerbatim(draft, 'No Such Section', 'x y').applied, false);
});

test('verbatim survival ignores renumbered markers, flags paraphrase', () => {
  const user = 'Cities should invest in green spaces to improve public health.[^2] Evidence links trees with lower stress for residents.';
  const kept = userSentenceSet(user);
  assert.equal(kept.size, 2);
  assert.deepEqual(missingVerbatim('Cities should invest in green spaces to improve public health.[^5] Evidence links trees with lower stress for residents.', kept), []);
  const missing = missingVerbatim('Municipalities ought to fund parks since foliage may calm citizens.', kept);
  assert.equal(missing.length, 2);
});

test('dangling markers are stripped, valid ones kept', () => {
  const draft = {
    introduction: ['Keep this.[^1] Drop this.[^9]'],
    sections: [],
    conclusion: [],
    footnotes: [{ id: 1 }],
  };
  dropDanglingMarkers(draft);
  assert.equal(draft.introduction[0], 'Keep this.[^1] Drop this.');
});

test('summaries never truncate mid-word', () => {
  assert.equal(cutAtWord('Replace the introduction with supplied text', 20), 'Replace the');
  assert.equal(cutAtWord('Short', 20), 'Short');
});
