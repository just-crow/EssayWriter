const { test } = require('node:test');
const assert = require('node:assert/strict');
const nim = require('../lib/nim.ts');
const { prisma } = require('../lib/db.ts');
const { POST } = require('../app/api/refine/route.ts');

const URL = 'https://example.org/green';
const CONTENT = 'Alpha research finding about Beta outcomes in controlled trials. Further Beta analysis continues across additional shared study groups. Dense city districts show measurable green roof benefits today. Green roof planning supports biodiversity while reducing building temperatures. Cities should weigh upkeep costs alongside benefits carefully.';
const FN = { id: 1, author: '', title: 'Study', publisher: '', year: '', url: URL, accessed: 'd' };
const INTRO = 'Alpha research finding about Beta outcomes in controlled trials.[^1] Further Beta analysis continues across additional shared study groups.[^1] Dense city districts show measurable green roof benefits today.';
const BODY = 'Green roof planning supports biodiversity while reducing building temperatures in dense city districts.[^1] Cities should weigh upkeep costs alongside benefits carefully across districts.[^1] Shared study groups continue Beta analysis with consistent methods today.[^1] Further Beta analysis continues across additional shared study groups in dense districts.[^1] Measurable green roof benefits support biodiversity planning in city districts today.[^1] Controlled trials show measurable outcomes across districts today.[^1]';
const CONCL = 'Beta outcomes merit sustained attention across districts today. Cities should weigh upkeep costs alongside benefits carefully and consistently over time. Shared study groups continue analysis across additional districts today together.';

function essay() {
  return {
    title: 'T',
    introduction: [INTRO],
    sections: [{ heading: 'Results', paragraphs: [BODY] }],
    conclusion: [CONCL],
    footnotes: [{ ...FN }],
    worksCited: [],
    evidence: [],
    coverage: [],
  };
}

test('a wiped introduction is restored by retry, never shipped blank', async () => {
  const original = nim.nimChatLong;
  let auditCalls = 0;
  nim.nimChatLong = async (params) => {
    const system = params.system;
    // A retry carries validation feedback; the revision answers it with an
    // extra intro sentence so the audit sees fresh (uncached) text.
    const revised = params.user.includes('VALIDATION FAILURE');
    if (system.includes('CONCLUSION CHECK')) {
      const batch = JSON.parse(params.user.split('ESSAY PARAGRAPHS AND SENTENCES:\n')[1].split('\n\nReturn')[0]);
      return JSON.stringify({ claims: batch.flatMap((p) => p.sentences.map((s) => ({ paragraph: p.paragraph, sentenceIndex: s.sentenceIndex, status: 'logical_inference', onTopic: true, reason: 'Synthesis.' }))) });
    }
    if (system.includes('source-grounding auditor')) {
      const call = ++auditCalls;
      const batch = JSON.parse(params.user.split('ESSAY PARAGRAPHS AND SENTENCES:\n')[1].split('\n\nReturn')[0]);
      return JSON.stringify({ claims: batch.flatMap((p) => p.sentences.map((s) => {
        // First audit wipes the introduction entirely; later rounds verify it.
        if (call === 1 && p.paragraph === 0) {
          return { paragraph: p.paragraph, sentenceIndex: s.sentenceIndex, status: 'unsupported', onTopic: true, reason: 'Not established.' };
        }
        return { paragraph: p.paragraph, sentenceIndex: s.sentenceIndex, status: 'supported', onTopic: true, supportingSourceIndex: 0, supportingPassageIndexes: [0], reason: 'Directly stated.' };
      })) });
    }
    // Writer: return the base essay (revised intro on retry so the audit
    // cache cannot replay the wipe with identical text).
    const base = essay();
    if (revised) base.introduction = [`${INTRO} Additional shared study groups continue green roof analysis today.[^1]`];
    return JSON.stringify(base);
  };
  try {
    const project = await prisma.project.create({ data: { title: 'T', topic: 'Green', instruction: '', wordTarget: 400 } });
    await prisma.source.create({
      data: { projectId: project.id, author: '', title: 'Study', publisher: '', year: '', url: URL, accessed: 'd', supports: '', content: CONTENT },
    });
    const version = await prisma.essayVersion.create({
      data: { projectId: project.id, version: 1, title: 'T', essayJson: JSON.stringify(essay()), docxPath: '', wordCount: 100, footnoteCount: 1, summary: '' },
    });
    const res = await POST(new Request('http://localhost/api/refine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        versionId: version.id,
        instruction: 'Shorten the conclusion slightly.',
        minimumFootnotes: 1,
        minimumSources: 1,
      }),
    }));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.draft.introduction.join(' ').trim().length > 0, 'introduction restored, not shipped blank');
    assert.ok(auditCalls >= 2, 'audit retried after the wipe');
  } finally {
    nim.nimChatLong = original;
  }
});
