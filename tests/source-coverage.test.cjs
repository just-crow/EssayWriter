const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planSourceQueries, selectBalancedSources } = require('../app/api/sources/route.ts');
const { buildSources } = require('../lib/search.ts');

test('searches later outline sections before individual points and reserves their sources', () => {
  const sections = ['Context', 'Mechanisms', 'Evidence', 'Limitations', 'Equity', 'Governance'];
  const queries = planSourceQueries('Urban trees', JSON.stringify({ sections: sections.map(heading => ({
    heading, paragraphs: [{ point: `Question to investigate: ${heading} findings` }],
  })) }));
  assert.deepEqual(queries.slice(0, sections.length).map(query => query.label),
    sections.map(heading => `the section “${heading}”`));
  assert.ok(queries.some(query => query.label === 'the section “Governance”'));

  const results = [
    ...Array.from({ length: 12 }, (_, i) => ({ title: `Context ${i}`, url: `https://example.org/context-${i}`, query: queries[0].text, score: 1 - i / 100 })),
    ...sections.slice(1).map((heading, i) => ({ title: heading, url: `https://example.org/${heading}`, query: queries[i + 1].text, score: 0.1 })),
  ];
  const selected = selectBalancedSources(results, queries, 12);
  for (const heading of sections.slice(1)) assert.ok(selected.some(item => item.title === heading), `${heading} was skipped`);
});

test('a page returned for two queries is not counted as evidence for both sections', () => {
  const result = { title: 'Cross-cutting study', url: 'https://example.org/study', publisher: 'example.org',
    date: '2025', score: 1, snippet: 'Evidence', query: 'q1', queries: ['q1', 'q2'] };
  const [source] = buildSources([result], new Map([
    ['q1', 'the section “Benefits”'], ['q2', 'the section “Limitations”'],
  ]), '28 Sept. 2026');
  assert.match(source.supports, /Benefits/);
  assert.doesNotMatch(source.supports, /Limitations/);
});

test('substantive pages take source slots before category listings', () => {
  const queries = [{ text: 'q', label: 'the section “Social impacts”' }];
  const results = [
    { title: 'Category index', url: 'https://example.org/category/urban-trees', query: 'q' },
    { title: 'Study', url: 'https://example.org/research/urban-trees', query: 'q' },
  ];
  assert.equal(selectBalancedSources(results, queries, 1)[0].title, 'Study');
});
