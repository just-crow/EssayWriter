const { test } = require('node:test');
const assert = require('node:assert/strict');
const { citationCounts, assertCitationMinimums } = require('../lib/citation-limits.ts');
const { evidenceSpine } = require('../lib/evidence-spine.ts');

test('repeated footnotes meet the citation floor but cannot masquerade as distinct works', () => {
  const draft = { introduction: ['First finding.[^1] Second finding.[^1]'], sections: [], conclusion: [], footnotes: [{ id: 1, url: 'https://example.com/work' }, { id: 2, url: 'https://example.org/unused' }] };
  assert.deepEqual(citationCounts(draft), { footnotes: 2, works: 1 });
  assert.throws(() => assertCitationMinimums(draft, 2, 2), /distinct works/);
  assert.throws(() => assertCitationMinimums(draft, 3, 1), /3 footnotes/);
  draft.conclusion.push('Other finding.[^2] Missing note.[^99]');
  assert.deepEqual(citationCounts(draft), { footnotes: 3, works: 2 });
  assert.doesNotThrow(() => assertCitationMinimums(draft, 3, 2));
});

test('minimum works retains additional genuine findings and does not count duplicate snapshots', () => {
  const sources = [
    { id: '1', url: 'https://example.edu/course', content: 'The computing course teaches students formal logic and mathematical proofs through weekly classroom exercises.' },
    { id: '2', url: 'https://example.edu/course', content: 'The computing course teaches students formal logic and mathematical proofs through weekly classroom exercises.' },
    { id: '3', url: 'https://example.org/book', content: 'The mathematics textbook introduces sets and relations before developing the notation used in discrete mathematics.' },
  ];
  const findings = JSON.parse(evidenceSpine(sources, sources, 12, 2));
  assert.deepEqual(findings.map(f => f.sourceId), ['1', '3']);
});

test('alternate views and mirrored copies of one publication cannot inflate the work minimum',()=>{
  const title='Precision Breeding Techniques and Their Application in Modern Plant Improvement';
  const draft={introduction:['A finding.[^1] Another finding.[^2] A third finding.[^3]'],sections:[],conclusion:[],footnotes:[
    {id:1,title,url:'https://example.org/paper?view=abstract'},
    {id:2,title,url:'https://example.org/paper'},
    {id:3,title,url:'https://doi.org/10.1234/example'},
  ]};
  assert.deepEqual(citationCounts(draft),{footnotes:3,works:1});
  assert.throws(()=>assertCitationMinimums(draft,3,3),/1 distinct works/);
});
