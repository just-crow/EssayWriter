const { test } = require('node:test');
const assert = require('node:assert/strict');
const nim = require('../lib/nim.ts');
const { assertUncitedConclusion } = require('../lib/citation-limits.ts');
const { auditAndAlignGrounding } = require('../lib/grounding-audit.ts');
const { writerDraftSchema } = require('../lib/essay-types.ts');

test('conclusion footnotes are rejected instead of being silently stripped', () => {
  assert.throws(() => assertUncitedConclusion({ conclusion: ['A claim.[^1]'] }), /no citations/);
  assert.doesNotThrow(() => assertUncitedConclusion({ conclusion: ['A synthesis of earlier points.'] }));
  const draft = { title: 'Essay', introduction: ['Opening.[^1]'], sections: [{ heading: 'Evidence', paragraphs: ['Finding.[^1]'] }], conclusion: ['Closing.[^1]'] };
  assert.equal(writerDraftSchema().safeParse(draft).success, false);
  draft.conclusion = ['Closing without new information.'];
  assert.equal(writerDraftSchema().safeParse(draft).success, true);
});

test('conclusion verification uses only established essay points and rejects new information', async () => {
  const original = nim.nimChatLong;
  const url = 'https://example.org/study';
  const fact = 'The study observed a difference between the two measured groups.';
  const draft = { title: 'Essay', introduction: [], sections: [{ heading: 'Evidence', paragraphs: [`${fact}[^1]`] }], conclusion: ['This comparison brings the argument together. The measured groups differed in the study. A newly introduced mechanism explains the difference.'], footnotes: [{ id: 1, url }], evidence: [], worksCited: [], coverage: [] };
  let checkedConclusion = false;
  nim.nimChatLong = async request => {
    if (request.system.includes('CONCLUSION CHECK:')) {
      checkedConclusion = true;
      assert.ok(request.user.includes(fact));
      assert.ok(request.user.includes('SOURCES:\n[]'));
      assert.doesNotMatch(request.system, /strict academic source-grounding auditor/);
      return JSON.stringify({ claims: [
        { paragraph: 1, sentenceIndex: 0, status: 'logical_inference', reason: 'Synthesis of the established comparison.' },
        { paragraph: 1, sentenceIndex: 1, status: 'supported', reason: 'A faithful restatement of the established finding.' },
        { paragraph: 1, sentenceIndex: 2, status: 'unsupported', reason: 'A mechanism not established earlier.' },
      ] });
    }
    return JSON.stringify({ claims: [{ paragraph: 0, sentenceIndex: 0, status: 'supported', supportingSourceIndex: 0, supportingPassageIndexes: [0], reason: 'The original cited page supports the comparison.' }] });
  };
  try {
    const result = await auditAndAlignGrounding(draft, [{ url, content: fact, title: 'Study', author: '', publisher: '', year: '', accessed: '' }]);
    assert.ok(checkedConclusion);
    assert.equal(result.removed.length, 1);
    assert.equal(draft.conclusion[0], 'This comparison brings the argument together. The measured groups differed in the study.');
    assertUncitedConclusion(draft);
    assert.equal(draft.footnotes.length, 1);
  } finally { nim.nimChatLong = original; }
});
