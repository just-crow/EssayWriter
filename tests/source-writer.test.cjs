const { test } = require('node:test');
const assert = require('node:assert/strict');
const nim = require('../lib/nim.ts');
const { composeSourceDraft } = require('../lib/source-writer.ts');
const { cleanEssayVoice } = require('../lib/source-writer.ts');

test('essay voice removes source illustration references while preserving factual sentences and their citations', () => {
  const result = cleanEssayVoice('Edited plants resisted disease in the experiment.[^2] In summary, Figure 1 illustrates the applications of editing.[^2] The assigned findings do not establish long-term field performance.');
  assert.equal(result, 'Edited plants resisted disease in the experiment.[^2] The available evidence does not establish long-term field performance.');
});

test('essay voice removes source-stage commentary and raw markdown from prose', () => {
  const result = cleanEssayVoice('The source that frames this discussion asks which costs matter.[^1] Furthermore, *long-term maintenance* requires planning.[^2]');
  assert.equal(result, 'Long-term maintenance requires planning.[^2]');
});

test('essay voice clears stray quote and parenthesis artifacts', () => {
  assert.equal(cleanEssayVoice('The finding is supported.[^1] ) >Research adds detail.[^2]'), 'The finding is supported.[^1] Research adds detail.[^2]');
});

test('an early citation does not leave the rest of its assigned factual run uncited', async () => {
  const original = nim.nimChatLong;
  nim.nimChatLong = async params => {
    const ending = conclusionResponse(params);
    if (ending) return ending;
    const id = JSON.parse(params.user.match(/Assigned source finding: ([^\n]+)/)[1]).sourceId;
    const words = Number(params.user.match(/approximately (\d+) words/)[1]);
    const sentence = 'The measurements concern the particular conditions documented during the observation period and retain that limited scope.';
    return JSON.stringify({ paragraph: `${sentence}[^${id}] ${Array.from({length: Math.max(2, Math.ceil(words / 18))}, () => sentence).join(' ')}` });
  };
  try {
    const draft = await composeSourceDraft({topic: 'Measurements', wordTarget: 200, instructionText: '', extraInstructions: '', structureJson: '{"sections":[{"heading":"Results"}]}'}, [{id:'1', title:'Study', content:'The observation recorded measurements under the conditions documented in the report.'}]);
    for (const paragraph of [...draft.introduction, ...draft.sections[0].paragraphs]) assert.match(paragraph, /\[\^1\]$/);
  } finally { nim.nimChatLong = original; }
});
const summary = 'Taken together, the discussion brings the central points into a connected account of the topic. The established findings provide the basis for the argument developed in the essay. This synthesis returns to that argument without extending it beyond the discussion.';

test('repetition instructions remain advisory and do not reject otherwise valid paragraphs', async () => {
  const original = nim.nimChatLong;
  const opening = 'The evidence describes how the measured groups differed during the observation period. The results concern the conditions recorded by the researchers in that particular study. Their observations provide the factual starting point for this discussion.';
  const fresh = 'The comparison concentrates on the differences recorded between the groups rather than introducing a general explanation for the observed result. Its scope remains restricted to the measurements described by the researchers, preserving the limitations of the original account without adding a causal mechanism. These distinctions allow the discussion to organize the available observations into a specific comparison while retaining the uncertainty and qualifications stated in the evidence. Considering the findings together provides a developed account of the measured differences and the boundaries of the comparison presented in the source.';
  let bodyAttempts = 0;
  nim.nimChatLong = async params => {
    const ending = conclusionResponse(params);
    if (ending) return ending;
    const finding = JSON.parse(params.user.match(/Assigned source finding: ([^\n]+)/)[1]);
    if (params.user.includes('Paragraph role: introduction')) return JSON.stringify({ paragraph: `${opening}[^${finding.sourceId}]` });
    assert.ok(params.user.includes(opening));
    assert.match(params.system, /Avoid repeating sentences within or across paragraphs/);
    if (++bodyAttempts === 1) {
      // Word budgets scale with the essay target; pad the fixed mock prose
      // to the requested floor so the mock stays a valid paragraph.
      const words = Number(params.user.match(/approximately (\d+) words/)[1]);
      const filler = 'These distinctions remain within the measurements described by the researchers.';
      let paragraph = `${opening.split('. ')[0]}. ${fresh}`;
      while (paragraph.split(/\s+/).filter(Boolean).length < Math.ceil(words * 0.65)) paragraph += ` ${filler}`;
      return JSON.stringify({ paragraph: `${paragraph}[^${finding.sourceId}]` });
    }
    assert.match(params.user, /This paragraph repeats substantial sentences already written/);
    return JSON.stringify({ paragraph: `${fresh}[^${finding.sourceId}]` });
  };
  try {
    const result = await composeSourceDraft({ topic: 'Group differences', wordTarget: 200, minimumSources: 2, instructionText: '', extraInstructions: '', structureJson: '{"sections":[{"heading":"Comparison"}]}' }, [
      { id: '1', title: 'Study', content: 'The measured groups differed during the observation period under the conditions recorded by the researchers.' },
      { id: '2', title: 'Comparison', content: 'The comparison describes differences between the groups and limits its findings to the measurements recorded during the study.' },
    ]);
    assert.equal(bodyAttempts, 1);
    assert.equal(require('../lib/validate.ts').repeatedSentences([...result.introduction, ...result.sections[0].paragraphs, ...result.conclusion]).length, 1);
  } finally { nim.nimChatLong = original; }
});
function conclusionResponse(params) {
  if (!params.system.startsWith('Write one academic conclusion')) return null;
  assert.match(params.system, /No citations or footnote markers/);
  assert.doesNotMatch(params.user, /Assigned source finding/);
  assert.ok(JSON.parse(params.user.split('Already written introduction and body:\n')[1].split('\nWrite approximately')[0]).length >= 2);
  return JSON.stringify({ paragraph: summary });
}

test('an optional editorial rewrite cannot turn a valid sourced paragraph into a service error', async () => {
  const original = nim.nimChatLong;
  let polishAttempts = 0;
  nim.nimChatLong = async params => {
    const ending = conclusionResponse(params);
    if (ending) return ending;
    if (params.user.includes('EDITORIAL REVISION:')) {
      polishAttempts++;
      throw new Error('Service temporarily overloaded');
    }
    const id = JSON.parse(params.user.match(/Assigned source finding: ([^\n]+)/)[1]).sourceId;
    const words = Number(params.user.match(/approximately (\d+) words/)[1]);
    const sentence = 'This review explores the recorded measurements and their limited interpretation in the conditions described.';
    const text = Array.from({ length: Math.max(3, Math.ceil(words / 16)) }, () => sentence).join(' ');
    return JSON.stringify({ paragraph: `${text}[^${id}]` });
  };
  try {
    const draft = await composeSourceDraft({ topic: 'Measurements', wordTarget: 200, instructionText: '', extraInstructions: '', structureJson: '{"sections":[{"heading":"Results"}]}' }, [{ id: '1', title: 'Study', content: 'The study recorded measurements under the conditions described in its account of the observations.' }]);
    assert.equal(polishAttempts, 2);
    assert.match(draft.sections[0].paragraphs[0], /\[\^1\]/);
  } finally { nim.nimChatLong = original; }
});

test('paragraph assignments do not reuse consumed findings while fresh findings remain', async () => {
  const original = nim.nimChatLong;
  const consumed = new Set();
  nim.nimChatLong = async params => {
    const ending = conclusionResponse(params);
    if (ending) return ending;
    const assigned = JSON.parse(params.user.match(/All assigned findings: ([^\n]+)/)[1]);
    for (const finding of assigned) {
      assert.ok(!consumed.has(finding.text), 'Each paragraph should receive unused factual material.');
      consumed.add(finding.text);
    }
    return JSON.stringify({ paragraph: assigned.map(f => f.text).join(' ') + '[^1]' });
  };
  try {
    await composeSourceDraft({ topic: 'Observations', wordTarget: 200, instructionText: '', extraInstructions: '', structureJson: '{"sections":[{"heading":"Results"}]}' }, [{
      id: '1', title: 'Measurements', content: Array.from({ length: 30 }, (_, i) => `Observation number ${i} recorded a distinct measurement under the conditions specified in the report.`).join(' '),
    }]);
    assert.ok(consumed.size > 3);
  } finally { nim.nimChatLong = original; }
});

test('paragraph composition binds citations to assigned source findings and repairs a wrong source ID', async () => {
  const original = nim.nimChatLong;
  const prompts = [];
  let wrong = true;
  let active = 0;
  nim.nimChatLong = async (params) => {
    assert.equal(++active, 1, 'Draft paragraphs must not compete for free endpoint capacity.');
    await new Promise(resolve => setImmediate(resolve));
    active--;
    assert.equal(params.tries, 4);
    assert.equal(params.responseFormat.type, 'json_schema');
    const ending = conclusionResponse(params);
    if (ending) return ending;
    prompts.push(params.user);
    const finding = JSON.parse(params.user.match(/Assigned source finding: ([^\n]+)/)[1]);
    const words = Number(params.user.match(/approximately (\d+) words/)[1]);
    const id = wrong ? 999 : finding.sourceId;
    wrong = false;
    const assigned = JSON.parse(params.user.match(/All assigned findings: ([^\n]+)/)[1]);
    const beginning = assigned.map((item, index) => `${item.text}[^${index === 0 ? id : item.sourceId}]`).join(' ');
    const recommendation = 'The proposed platform should provide a workspace in which students can record their reasoning and explain each step of a proposed solution.';
    const paragraph = beginning + ' ' + Array.from({ length: Math.max(1, Math.round((words - beginning.split(/\s+/).length) / recommendation.split(/\s+/).length)) }, (_, index) => `For paragraph ${prompts.length} consideration ${index}, ${recommendation}`).join(' ');
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
    const ending = conclusionResponse(params);
    if (ending) return ending;
    const findings = JSON.parse(params.user.match(/All assigned findings: ([^\n]+)/)[1]);
    assignments.push(findings);
    assert.match(params.user, /These are minimums, not exact counts or caps: more are allowed/);
    const words = Number(params.user.match(/approximately (\d+) words/)[1]);
    let paragraph = findings.map(f => `For discussion ${assignments.length}, ${f.text}[^${f.sourceId}]`).join(' ');
    while (paragraph.split(/\s+/).length < words * 0.85 || require('../lib/validate.ts').splitSentences(paragraph).length < 3) paragraph += ` For consideration ${paragraph.split(/\s+/).length} in discussion ${assignments.length}, I propose a workspace for explaining the steps of each solution and recording questions for later discussion with classmates.`;
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
  const previous = { introduction: [prose(42)], sections: [{ heading: 'Cell structure', paragraphs: ['A surviving finding.[^1]'] }, { heading: 'An old unused section', paragraphs: ['An old section not in this outline.'] }], conclusion: [prose(42)] };
  let calls = 0;
  nim.nimChatLong = async params => {
    calls++;
    const ending = conclusionResponse(params);
    if (ending) return ending;
    assert.match(params.system, /No subject or application domain is assumed/);
    return JSON.stringify({ paragraph: prose(Number(params.user.match(/approximately (\d+) words/)[1]) - 20) });
  };
  try {
    const result = await composeSourceDraft({ topic: 'Cells', wordTarget: 400, instructionText: '', extraInstructions: '', structureJson: JSON.stringify({ sections: [{ heading: 'Cell structure' }] }) }, [{ id: '1', title: 'Cells', content: 'The textbook describes cells as the smallest structural and functional units of living organisms.' }], 'The source audit removed unsupported comparisons.', previous);
    assert.equal(calls, 2);
    assert.equal(result.introduction[0], previous.introduction[0]);
    assert.equal(result.conclusion[0], summary);
    assert.doesNotMatch(result.conclusion[0], /\[\^/);
    assert.ok(result.sections[0].paragraphs[0].split(/\s+/).length >= 240);
    calls = 0;
    await composeSourceDraft({ topic: 'Cells', wordTarget: 400, instructionText: '', extraInstructions: '', structureJson: JSON.stringify({ sections: [{ heading: 'Cell structure' }] }) }, [{ id: '1', title: 'Cells', content: 'The textbook describes cells as the smallest structural and functional units of living organisms.' }], 'The essay repeats substantial sentences across paragraphs.', previous);
    assert.equal(calls, 2, 'Repetition feedback must not force regeneration of valid paragraphs.');
  } finally { nim.nimChatLong = original; }
});
