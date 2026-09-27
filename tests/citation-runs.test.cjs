const { test } = require('node:test');
const assert = require('node:assert/strict');
const { citationScopes, groupCitationRuns } = require('../lib/citation-runs.ts');
const { citationCounts, assertCitationMinimums } = require('../lib/citation-limits.ts');
const { verifyEvidence, sourcesTextMap } = require('../lib/validate.ts');

test('one closing footnote covers preceding sentences up to the previous footnote', () => {
  assert.deepEqual(citationScopes('First claim. Second claim.[^1] Third claim. Fourth claim.[^2] Uncited ending.').map(item => item.ids), [[1], [1], [2], [2], []]);
});

test('consecutive same-work citations collapse without losing any verified evidence', () => {
  const url = 'https://example.org/study';
  const sentences = ['The study describes the first observed result.', 'The study describes the second observed result.', 'The study describes the third observed result.'];
  const draft = { introduction: [], sections: [{ heading: 'Results', paragraphs: [sentences.map((sentence, i) => `${sentence}[^${i + 1}]`).join(' ')] }], conclusion: [], footnotes: sentences.map((_, i) => ({ id: i + 1, url, title: 'Study' })), evidence: sentences.map((quote, i) => ({ paragraph: 0, source: i + 1, quote })), worksCited: [] };
  groupCitationRuns(draft);
  assert.equal(draft.sections[0].paragraphs[0], `${sentences.join(' ')}[^1]`);
  assert.equal(draft.footnotes.length, 1);
  assert.equal(draft.evidence.length, 3);
  assert.ok(draft.evidence.every(item => item.source === 1));
  assert.deepEqual(verifyEvidence(draft.evidence, draft.footnotes, sourcesTextMap([{ url, content: sentences.join(' ') }])), []);
  assert.deepEqual(citationCounts(draft), { footnotes: 1, works: 1 });
  assert.throws(() => assertCitationMinimums(draft, 3, 1), /3 footnotes/);
  const once = JSON.stringify(draft);
  groupCitationRuns(draft);
  assert.equal(JSON.stringify(draft), once);
});

test('source changes, paragraph boundaries and uncited commentary keep separate footnotes', () => {
  const a = 'https://example.org/a', b = 'https://example.org/b';
  const draft = { introduction: ['First fact.[^1] Second fact.[^2] Third fact.[^3]'], sections: [{ heading: 'Other', paragraphs: ['Another fact.[^4] My interpretation. Last fact.[^5]'] }], conclusion: [], footnotes: [a, b, a, a, a].map((url, i) => ({ id: i + 1, url })), evidence: [], worksCited: [] };
  groupCitationRuns(draft);
  assert.deepEqual(citationCounts(draft), { footnotes: 5, works: 2 });
  assert.equal(draft.introduction[0], 'First fact.[^1] Second fact.[^2] Third fact.[^3]');
});
