const { test } = require('node:test');
const assert = require('node:assert/strict');
const nim = require('../lib/nim.ts');
const { composeSourceDraft } = require('../lib/source-writer.ts');

test('paragraph composition binds citations to assigned source findings and repairs a wrong source ID', async () => {
  const original = nim.nimChatLong;
  const prompts = [];
  let wrong = true;
  nim.nimChatLong = async (params) => {
    prompts.push(params.user);
    const finding = JSON.parse(params.user.match(/Assigned source finding: ([^\n]+)/)[1]);
    const words = Number(params.user.match(/approximately (\d+) words/)[1]);
    const id = wrong ? 999 : finding.sourceId;
    wrong = false;
    const assigned = JSON.parse(params.user.match(/All assigned findings: ([^\n]+)/)[1]);
    const beginning = assigned.map((item, index) => `${item.text}[^${index === 0 ? id : item.sourceId}]`).join(' ');
    const recommendation = 'The proposed platform should provide a workspace in which students can record their reasoning and explain each step of a proposed solution.';
    const paragraph = beginning + ' ' + Array.from({ length: Math.max(1, Math.round((words - beginning.split(/\s+/).length) / recommendation.split(/\s+/).length)) }, () => recommendation).join(' ');
    return JSON.stringify({ paragraph: paragraph });
  };
  try {
    const sources = [
      { id: '2', title: 'Curriculum', content: 'The curriculum identifies mathematical foundations required for algorithm development and the design of computing systems.' },
      { id: '8', title: 'Course', content: 'The incoming computing students study logic and sets while learning how to construct formal mathematical proofs.' },
    ];
    const result = await composeSourceDraft({ topic: 'Proposed platform', wordTarget: 400, instructionText: '', extraInstructions: '', structureJson: JSON.stringify({ sections: [{ heading: 'Proof practice' }] }) }, sources);
    assert.equal(result.sections[0].heading, 'Proof practice');
    assert.equal(result.introduction.length, 1);
    assert.equal(result.conclusion.length, 1);
    assert.ok(prompts.some((prompt) => prompt.includes('Use only [^')));
    const paragraphs = [...result.introduction, ...result.sections.flatMap((section) => section.paragraphs), ...result.conclusion];
    assert.ok(paragraphs.every((paragraph) => !paragraph.includes('[^999]')));
    assert.match(result.sections[0].paragraphs[0], /\[\^8\]/);
    assert.equal(result.evidence.length, 0, 'Exact evidence is derived from the independent source check.');
  } finally { nim.nimChatLong = original; }
});

test('higher footnote minimum requests enough citations from findings assigned before composition', async () => {
  const original = nim.nimChatLong;
  const assignments = [];
  nim.nimChatLong = async (params) => {
    const findings = JSON.parse(params.user.match(/All assigned findings: ([^\n]+)/)[1]);
    assignments.push(findings);
    assert.match(params.user, /These are minimums, not exact counts or caps: more are allowed/);
    const words = Number(params.user.match(/approximately (\d+) words/)[1]);
    let paragraph = findings.map(f => `${f.text}[^${f.sourceId}]`).join(' ');
    while (paragraph.split(/\s+/).length < words * 0.85) paragraph += ' I propose a workspace for explaining the steps of each solution and recording questions for later discussion with classmates.';
    return JSON.stringify({ paragraph });
  };
  try {
    const result = await composeSourceDraft({ topic: 'Mathematical practice', wordTarget: 400, minimumFootnotes: 6, minimumSources: 2, instructionText: '', extraInstructions: '', structureJson: JSON.stringify({ sections: [{ heading: 'Practice' }] }) }, [
      { id: '1', title: 'Curriculum', content: 'The curriculum identifies mathematical foundations required for algorithm development and the design of computing systems.' },
      { id: '2', title: 'Course', content: 'The incoming computing students study logic and sets while learning how to construct formal mathematical proofs.' },
    ]);
    assert.ok(assignments.every(findings => findings.length >= 1 && new Set(findings.map(f => f.sourceId)).size === 1));
    const text = [...result.introduction, ...result.sections.flatMap(s => s.paragraphs), ...result.conclusion].join(' ');
    assert.ok([...text.matchAll(/\[\^\d+\]/g)].length >= 3);
    assert.ok(new Set(assignments.flatMap(findings => findings.map(f => f.sourceId))).size >= 2);
    assert.ok(assignments.length >= 3);
  } finally { nim.nimChatLong = original; }
});

test('source repair retains verified complete paragraphs and rewrites only the depleted paragraph', async () => {
  const original = nim.nimChatLong;
  const prose = words => 'The source describes the structure of cells.[^1] ' + 'This paragraph considers that description. '.repeat(Math.ceil(words / 6));
  const previous = { introduction: [prose(42)], sections: [{ heading: 'Cell structure', paragraphs: ['A surviving finding.[^1]'] }], conclusion: [prose(42)] };
  let calls = 0;
  nim.nimChatLong = async params => {
    calls++;
    assert.match(params.system, /No subject or application domain is assumed/);
    return JSON.stringify({ paragraph: prose(Number(params.user.match(/approximately (\d+) words/)[1]) - 20) });
  };
  try {
    const result = await composeSourceDraft({ topic: 'Cells', wordTarget: 400, instructionText: '', extraInstructions: '', structureJson: JSON.stringify({ sections: [{ heading: 'Cell structure' }] }) }, [{ id: '1', title: 'Cells', content: 'The textbook describes cells as the smallest structural and functional units of living organisms.' }], 'The source audit removed unsupported comparisons.', previous);
    assert.equal(calls, 1);
    assert.equal(result.introduction[0], previous.introduction[0]);
    assert.equal(result.conclusion[0], previous.conclusion[0]);
    assert.ok(result.sections[0].paragraphs[0].split(/\s+/).length >= 240);
  } finally { nim.nimChatLong = original; }
});
