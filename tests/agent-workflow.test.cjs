const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanSourceTitle, qualityWeight } = require('../lib/search.ts');
const { buildCoverage, uncoveredClaimTerms, sharesRoot, tidyVerifiedParagraph } = require('../lib/validate.ts');
const { sourceFindingSentences } = require('../lib/paragraph-plan.ts');
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

test('coverage builder locates each requirement in the essay', () => {
  const draft = {
    title: 't', introduction: ['Rivers shape valleys through erosion.'], conclusion: ['Valleys reflect erosion.'],
    footnotes: [], worksCited: [], evidence: [], coverage: [],
    sections: [{ heading: 'Erosion Processes', paragraphs: ['Rainfall drives erosion on steep slopes.'] }],
  };
  const rows = buildCoverage(
    ['Explain how erosion shapes valleys', 'Meet the 1000-word target', 'Discuss rainfall on slopes'],
    draft
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].met, true);
  assert.ok(rows[0].location.length > 0);
  assert.equal(rows[1].met, true);
  assert.equal(rows[1].location, 'Section “Erosion Processes”');
});

test('search titles repair double-encoded punctuation', () => {
  const { repairMojibake } = require('../lib/search.ts');
  assert.equal(repairMojibake('environmental justice â€“ city study'), 'environmental justice – city study');
});

test('verified paragraphs lose orphan artifacts, never meaning', () => {
  assert.equal(
    tidyVerifiedParagraph('Benefits are clear. . Research shows gains.[^2] not automatic. they depend on design.'),
    'Benefits are clear. Research shows gains.[^2] Not automatic. They depend on design.'
  );
  assert.equal(
    tidyVerifiedParagraph('Trees help, e.g. oaks, in streets.'),
    'Trees help, e.g. oaks, in streets.'
  );
});

test('writer-stage voice removes banned punctuation', () => {
  const { cleanEssayVoice } = require('../lib/source-writer.ts');
  assert.equal(
    cleanEssayVoice('Ties strengthened, and isolation fell—factors linked to health.[^4] Parks help; cities benefit.'),
    'Ties strengthened, and isolation fell, factors linked to health.[^4] Parks help. cities benefit.'
  );
});

test('works cited collapses URL variants into one entry', () => {
  const { rebuildWorksCited } = require('../lib/validate.ts');
  const draft = {
    title: 't', introduction: ['a[^1][^2][^3]'], sections: [], conclusion: ['c'],
    footnotes: [
      { id: 1, author: '', title: 'Rice Study', publisher: 'example.edu', year: '2024', url: 'https://example.edu/rice', accessed: '30 Sept 2026' },
      { id: 2, author: '', title: 'Rice Study', publisher: 'example.edu', year: '2024', url: 'https://example.edu/rice/', accessed: '30 Sept 2026' },
      { id: 3, author: '', title: 'Rice Study', publisher: 'example.edu', year: '2024', url: 'https://WWW.example.edu/rice?utm_source=x', accessed: '30 Sept 2026' },
    ],
    evidence: [], coverage: [],
  };
  rebuildWorksCited(draft);
  assert.equal(draft.worksCited.length, 1);
  assert.match(draft.worksCited[0], /Rice Study/);
});

test('coverage matches rhetorical moves by signal phrases', () => {
  const { buildCoverage } = require('../lib/validate.ts');
  const draft = {
    title: 't', introduction: ['Parks cost money.'], conclusion: ['Weigh costs.'],
    footnotes: [], worksCited: [], evidence: [], coverage: [],
    sections: [{ heading: 'Costs', paragraphs: ['Limited funds carry opportunity costs for clinics.'] }],
  };
  const rows = buildCoverage(['Include at least one counterargument', 'Write in academic style'], draft);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].met, true);
  assert.ok(rows[0].location.includes('Costs'));
});

test('word-count checklist items are not prose coverage', () => {
  const { buildCoverage } = require('../lib/validate.ts');
  const draft = {
    title: 't', introduction: ['Rivers shape valleys.'], conclusion: ['Valleys persist.'],
    footnotes: [], worksCited: [], evidence: [], coverage: [],
    sections: [{ heading: 'Erosion', paragraphs: ['Rainfall drives erosion.'] }],
  };
  const rows = buildCoverage(['Explain erosion', 'Word target: 1000', 'Meet the 800-word target'], draft);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item, 'Explain erosion');
});

test('routing labels never reach essay prose', () => {
  const { stripRoutingLabels } = require('../lib/source-writer.ts');
  assert.equal(
    stripRoutingLabels('Health improved.[^5] >> section=2: Planning requires coordination.[^6]'),
    'Health improved.[^5] Planning requires coordination.[^6]'
  );
  assert.equal(stripRoutingLabels('Paragraph 3: Green spaces help cities.[^1]'), 'Green spaces help cities.[^1]');
});

test('standalone author-date debris is removed, inline attribution kept', () => {
  const { isCitationDebris } = require('../lib/source-writer.ts');
  assert.equal(isCitationDebris('Mogo et al., 2019).[^4]'), true);
  assert.equal(isCitationDebris('Knecht 2004).'), true);
  assert.equal(isCitationDebris('Research by Wilson and Xiao (2023) indicates parks save costs.[^9]'), false);
  assert.equal(isCitationDebris('Green spaces support health in dense cities.[^2]'), false);
});

test('search titles repair mojibake separators', () => {
  assert.equal(cleanSourceTitle('Health Benefits �?? Second Edition'), 'Health Benefits - Second Edition');
});

test('essay voice clears audit typographic fallout', () => {
  assert.equal(cleanEssayVoice('Its claims hold .  Rivers shaped the valley.[^1]'), 'Its claims hold. Rivers shaped the valley.[^1]');
});

test('lexical gate tolerates morphological paraphrase', () => {
  assert.deepEqual(
    uncoveredClaimTerms(
      'These mechanisms are associated with lower anxiety and improved mood in urban populations.',
      'The review finds a positive association between green space exposure and mood, with lower anxiety reported.'
    ),
    []
  );
});

test('lexical gate still rejects unrelated passages', () => {
  const missing = uncoveredClaimTerms(
    'Powdery-mildew-resistant wheat tolerates drought.',
    'The trial studied barley growth under dry conditions.'
  );
  assert.ok(missing.length > 0);
});

test('root matching joins derivations but never antonyms', () => {
  assert.equal(sharesRoot('associated', 'association'), true);
  assert.equal(sharesRoot('increase', 'decrease'), false);
});

test('methods search strings are not citable findings', () => {
  assert.deepEqual(
    sourceFindingSentences('Our outcome search term was the following: cognitive function* OR attention OR restoration OR mood OR stress.'),
    []
  );
});

test('funding boilerplate is not a citable finding', () => {
  assert.deepEqual(
    sourceFindingSentences('The study was funded in part by National Institutes of Health grants R01AA024941 and R49CE002474.'),
    []
  );
  assert.deepEqual(
    sourceFindingSentences('The authors declare no conflicts of interest in this research.'),
    []
  );
});
