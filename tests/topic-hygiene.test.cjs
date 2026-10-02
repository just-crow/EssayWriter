const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isBoilerplateSegment, cleanTopicForRetrieval } = require('../lib/topic-hygiene.ts');

test('school letterhead topics are detected as boilerplate', () => {
  assert.equal(
    isBoilerplateSegment('DRUGA GIMNAZIJA SARAJEVO IB MIDDLE YEARS PROGRAMME YEAR FIVE'),
    true
  );
  assert.equal(isBoilerplateSegment('MYP Year 5 Biology Criteria Sheet'), true);
  const cleaned = cleanTopicForRetrieval(
    'DRUGA GIMNAZIJA SARAJEVO IB MIDDLE YEARS PROGRAMME YEAR FIVE',
    'Should cities invest in urban green spaces?'
  );
  assert.equal(cleaned.boilerplate, true);
  assert.equal(cleaned.topic, 'Should cities invest in urban green spaces?');
});

test('genuine topics survive, including education subjects', () => {
  assert.equal(isBoilerplateSegment('Should schools ban mobile phones'), false);
  assert.equal(isBoilerplateSegment('Middle East conflicts and oil'), false);
  assert.equal(isBoilerplateSegment('The role of IB programmes in national education'), false);
  assert.equal(isBoilerplateSegment('High school dropout rates'), false);
  assert.equal(isBoilerplateSegment('Green roofs and city health'), false);
  assert.equal(isBoilerplateSegment('Photosynthesis'), false);
  const kept = cleanTopicForRetrieval('Should schools ban mobile phones', '');
  assert.equal(kept.boilerplate, false);
  assert.equal(kept.topic, 'Should schools ban mobile phones');
});

test('header segments split from mixed topics, thesis fills the void', () => {
  const mixed = cleanTopicForRetrieval(
    'To what extent do green spaces help cities? (MYP Year 5)',
    ''
  );
  assert.equal(mixed.boilerplate, true);
  assert.ok(mixed.topic.includes('To what extent'));
  assert.ok(!/MYP|Year 5/i.test(mixed.topic));
  const empty = cleanTopicForRetrieval('', '');
  assert.equal(empty.topic, '');
  assert.equal(empty.boilerplate, true);
});
