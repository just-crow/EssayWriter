const { test } = require('node:test');
const assert = require('node:assert/strict');
const nim = require('../lib/nim.ts');
const { auditAndAlignGrounding } = require('../lib/grounding-audit.ts');
const { selectWritingEvidence } = require('../lib/evidence-plan.ts');
const { evidenceSpine } = require('../lib/evidence-spine.ts');
const { prepareDraft, sourcesTextMap, verifyEvidence, consolidateSectionParagraphs } = require('../lib/validate.ts');

test('interactive learning is not the named method active learning, and explicit design aims remain proposals', async () => {
  const url = 'https://example.edu/course';
  const content = 'The course teaches mathematical proof techniques to incoming computer science students through logic and sets.';
  const fact = 'The course teaches mathematical proof techniques, relevant to the proposed interactive learning platform.';
  const proposal = 'I propose that the platform should provide a workspace to help learners record their reasoning.';
  const falseResearch = 'I propose this feature because research shows it improves student engagement.';
  const draft = { title: 'Platform', introduction: [], sections: [{ heading: 'Design', paragraphs: [`${fact}[^1] ${proposal} ${falseResearch}`] }], conclusion: [], footnotes: [{ id: 1, url }], evidence: [], worksCited: [], coverage: [] };
  const original = nim.nimChatLong;
  nim.nimChatLong = async () => JSON.stringify({ claims: [
    { paragraph: 0, sentenceIndex: 0, status: 'supported', supportingSourceIndex: 0, supportingPassageIndexes: [0], reason: 'Course facts followed by topic relevance.' },
    { paragraph: 0, sentenceIndex: 1, status: 'nonfactual', reason: 'Explicit proposed design aim.' },
    { paragraph: 0, sentenceIndex: 2, status: 'nonfactual', reason: 'Incorrectly exempted research assertion.' },
  ] });
  try {
    const result = await auditAndAlignGrounding(draft, [{ url, content, title: 'Course', author: '', publisher: '', year: '', accessed: '27 Sep 2026' }]);
    assert.equal(result.removed.length, 1);
    assert.ok(draft.sections[0].paragraphs[0].includes(fact));
    assert.ok(draft.sections[0].paragraphs[0].includes(proposal));
    assert.ok(!draft.sections[0].paragraphs[0].includes(falseResearch));
  } finally { nim.nimChatLong = original; }
});

test('prewriting selection uses actual relevant passages without asking the model to invent indexes', async () => {
  const sources = [
    { url: 'https://example.org/useful', content: 'A first factual passage about the curriculum.\nThe selected passage explains a mathematics requirement.' },
    { url: 'https://example.org/unused', content: 'This other source is unrelated to the essay topic.' },
  ];
  const original = nim.nimChatLong;
  try {
    nim.nimChatLong = async () => { throw new Error('Passage selection must not depend on model indexes.'); };
    const selected = await selectWritingEvidence(sources, 'Explain mathematics requirements.');
    assert.equal(selected.length, 1);
    assert.equal(selected[0].url, sources[0].url);
    assert.equal(selected[0].content, 'The selected passage explains a mathematics requirement.');

    const recovered = await selectWritingEvidence(sources, 'Explain mathematics requirements.');
    assert.ok(recovered.length > 0);
    assert.ok(recovered.every(source => sources.find(original => original.url === source.url).content.includes(source.content)));
    assert.ok(recovered[0].content.includes('mathematics requirement'));

    const mixed = await selectWritingEvidence(sources, 'Explain mathematics requirements.', { minimumSources: 2 });
    assert.equal(new Set(mixed.map(source => source.url)).size, 2);
    assert.ok(mixed.every(source => source.content.split('\n\n').every(passage => sources.find(original => original.url === source.url).content.includes(passage))));

    assert.ok((await selectWritingEvidence(sources, 'Explain mathematics requirements.')).length > 0);
  } finally { nim.nimChatLong = original; }
});

test('the prewriting evidence spine contains only observed findings from selected pages', () => {
  const content='The mathematics course asks students to construct formal proofs and explain their reasoning through collaborative work. The curriculum survey identifies probability and statistics as important mathematical subjects for computing education.';
  const primary={id:'4',url:'https://example.edu/course',content};
  const unrelated={id:'8',url:'https://example.com/catalog',content:'The catalog lists many different courses and certificates with numerous enrollment options for students.'};
  const facts=JSON.parse(evidenceSpine([{...primary,content:content+' The platform is proven to improve every learning outcome for all students in all subjects.'},unrelated],[primary,unrelated]));
  assert.equal(facts.length,2);
  for(const fact of facts){assert.equal(fact.sourceId,'4');assert.ok(content.includes(fact.text));}
});

test('malformed writer quotes are verified against original citations without assigning replacement sources', async () => {
  const url = 'https://example.org/study';
  const otherUrl = 'https://example.org/unused';
  const content = 'The study observed improved scores after practice.';
  const sources = [url, otherUrl].map((url) => ({ url, content, title: 'Study', author: '', publisher: '', year: '', accessed: '27 Sep 2026' }));
  const draft = {
    title: 'Practice', introduction: ['The study observed improved scores after practice.[^1]'],
    sections: [{ heading: 'Results', paragraphs: ['A fabricated detail.[^1] Another invented result.[^1] Research indicates that active learning improves student engagement.'] }],
    conclusion: ['This warrants further investigation.'],
    footnotes: [{ id: 1, url, title: 'Study' }], worksCited: [], coverage: [],
    evidence: [{ paragraph: 0, source: 1, quote: 'Not present on the page.' }],
  };
  prepareDraft(draft, sourcesTextMap(sources), { deferEvidence: true });
  const original = nim.nimChatLong;
  nim.nimChatLong = async (request) => {
    if (JSON.parse(request.user.split('ESSAY PARAGRAPHS AND SENTENCES:\n')[1].split('\n\nReturn')[0]).some(p => p.paragraph === 0)) assert.ok(request.user.includes(`"urls":["${url}"]`), 'the auditor receives complete original citation URLs');
    return JSON.stringify({ claims: [
    { paragraph: 0, sentenceIndex: 0, status: 'supported', supportingSourceIndex: 0, supportingPassageIndexes: [0], reason: 'Direct finding.' },
    { paragraph: 1, sentence: 'A fabricated detail.', status: 'supported', supportingUrl: otherUrl, supportingQuote: content, reason: 'Wrong source selected.' },
    { paragraph: 1, sentence: 'Another invented result.', status: 'supported', supportingUrl: url, supportingQuote: 'An invented supporting quotation.', reason: 'Invented quote.' },
    { paragraph: 1, sentence: 'Research indicates that active learning improves student engagement.', status: 'nonfactual', reason: 'Analysis.' },
    { paragraph: 2, sentence: 'This warrants further investigation.', status: 'nonfactual', reason: 'Recommendation.' },
  ] });
  };
  try {
    const audit = await auditAndAlignGrounding(draft, sources);
    assert.equal(audit.removed.length, 3);
    assert.equal(draft.sections[0].paragraphs[0], '');
    assert.deepEqual(draft.footnotes.map((note) => note.url), [url]);
    assert.deepEqual(verifyEvidence(draft.evidence, draft.footnotes, sourcesTextMap(sources)), []);
  } finally { nim.nimChatLong = original; }
});

test('paragraph merging keeps every evidence item at its final citation location', () => {
  const developed = 'This sentence develops the point with evidence and careful consideration. '.repeat(8);
  const draft = {
    introduction: ['Intro.[^1]'], conclusion: ['Conclusion.[^4]'],
    sections: [
      { heading: 'One', paragraphs: [`${developed}[^2]`] },
      { heading: 'Two', paragraphs: ['Short paragraph.[^3]'] },
    ],
    evidence: [1, 2, 3, 4].map((source, paragraph) => ({ paragraph, source, quote: 'A verified source passage.' })),
  };
  consolidateSectionParagraphs(draft);
  const paragraphs = [...draft.introduction, ...draft.sections.flatMap((section) => section.paragraphs), ...draft.conclusion];
  for (const evidence of draft.evidence) assert.ok(paragraphs[evidence.paragraph].includes(`[^${evidence.source}]`));
});

test('incomplete audit batches are repaired instead of deleting unchecked supported sentences', async () => {
  const url = 'https://example.org/cells';
  const content = 'The textbook describes cells as the smallest structural and functional units of living organisms.';
  const draft = { title: 'Cells', introduction: [`${content}[^1]`], sections: [{ heading: 'Structure', paragraphs: [`${content}[^1]`] }], conclusion: [`${content}[^1]`], footnotes: [{ id: 1, url }], evidence: [], worksCited: [], coverage: [] };
  const original = nim.nimChatLong;
  let repaired = false;
  const batchSizes = [];
  nim.nimChatLong = async request => {
    const batch = JSON.parse(request.user.split('ESSAY PARAGRAPHS AND SENTENCES:\n')[1].split('\n\nReturn')[0]);
    batchSizes.push(batch.length);
    if (batch.length === 2 && !request.user.includes('VALIDATION FAILURE:')) return JSON.stringify({ claims: [] });
    if (request.user.includes('VALIDATION FAILURE:')) {
      repaired = true;
      assert.match(request.user, /Missing audit entries are not evidence/);
    }
    return JSON.stringify({ claims: batch.flatMap(paragraph => paragraph.sentences.map(sentence => ({ paragraph: paragraph.paragraph, sentenceIndex: sentence.sentenceIndex, status: 'supported', supportingSourceIndex: 0, supportingPassageIndexes: [0], reason: 'The original page directly states this finding.' }))) });
  };
  try {
    const result = await auditAndAlignGrounding(draft, [{ url, content, title: 'Textbook', author: '', publisher: '', year: '', accessed: '' }]);
    assert.ok(repaired);
    assert.ok(batchSizes.every(size => size <= 2));
    assert.deepEqual(result.removed, []);
    assert.equal(draft.footnotes.length, 3);
    assert.ok(draft.conclusion[0].includes(content));
  } finally { nim.nimChatLong = original; }
});

test('one grouped paragraph footnote retains verification of every sentence', async () => {
  const url = 'https://example.org/curriculum';
  const content = 'The course covers mathematical proofs. The course includes weekly problem sets.';
  const sources = [{url, content, title:'Curriculum', author:'', publisher:'', year:'', accessed:'27 Sep 2026'}];
  const draft = { title:'Curriculum', introduction:[], sections:[{heading:'Course',paragraphs:[`${content}[^1]`]}], conclusion:[], footnotes:[{id:1,url}], evidence:[], worksCited:[], coverage:[] };
  const original = nim.nimChatLong;
  nim.nimChatLong = async (request) => {
    const paragraphs = JSON.parse(request.user.split('ESSAY PARAGRAPHS AND SENTENCES:\n')[1].split('\n\nReturn')[0]);
    assert.deepEqual(paragraphs[0].citedSources.map((sentence)=>sentence.urls), [[url],[url]]);
    return JSON.stringify({claims:[0,1].map((sentenceIndex)=>({paragraph:0,sentenceIndex,status:'supported',supportingSourceIndex:0,supportingPassageIndexes:[0],reason:'Direct course description.'}))});
  };
  try {
    await auditAndAlignGrounding(draft,sources);
    assert.equal(draft.footnotes.length,1);
    assert.ok(!draft.sections[0].paragraphs[0].includes('proofs.[^'));
    assert.ok(draft.sections[0].paragraphs[0].includes('sets.[^1]'));
    assert.deepEqual(verifyEvidence(draft.evidence,draft.footnotes,sourcesTextMap(sources)),[]);
  } finally { nim.nimChatLong = original; }
});
