const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GLOBAL_STYLE_RULES, STRUCTURE_SYSTEM, DRAFT_SYSTEM, REFINE_SYSTEM, structureUserPrompt, draftUserPrompt, suggestedSectionCount } = require('../lib/prompts.ts');

test('shared essay prompts do not prescribe a subject or learning-platform application', () => {
  for (const prompt of [STRUCTURE_SYSTEM, DRAFT_SYSTEM, REFINE_SYSTEM]) {
    assert.doesNotMatch(prompt, /platform|interactive learning|curriculum|gamification|cognitive.load|MYP essay specialist/i);
  }
  for (const topic of ['Cell structure', 'Causes of the French Revolution', 'Mathematical foundations']) {
    const input = { topic, instructionText: 'Write an analytical essay for a university reader.', extraInstructions: '', wordTarget: 1200, structureJson: '{}', sourcesJson: '[]', evidenceSpine: '[]' };
    assert.ok(structureUserPrompt(input).startsWith(`Topic: ${topic}\n`));
    assert.ok(draftUserPrompt(input).startsWith(`Topic: ${topic}\n`));
    assert.doesNotMatch(draftUserPrompt(input), /platform|interactive learning|curriculum|gamification/i);
  }
});

test('essays close with a conclusion unless instructions say otherwise', () => {
  assert.match(GLOBAL_STYLE_RULES, /close every essay with exactly one developed conclusion paragraph/);
  assert.match(GLOBAL_STYLE_RULES, /unless the user's instruction sheet explicitly forbids/);
  assert.match(STRUCTURE_SYSTEM, /Omit either only when the instruction sheet forbids it/);
});

test('outline section count scales with the word target', () => {
  assert.equal(suggestedSectionCount(400), 2);
  assert.equal(suggestedSectionCount(800), 3);
  assert.equal(suggestedSectionCount(1000), 4);
  assert.equal(suggestedSectionCount(1200), 5);
  assert.equal(suggestedSectionCount(3000), 6);
  const input = { topic: 'T', instructionText: '', extraInstructions: '', wordTarget: 1200, structureJson: '{}', sourcesJson: '[]', evidenceSpine: '[]' };
  assert.match(structureUserPrompt(input), /about 5 substantive body sections/);
  assert.match(STRUCTURE_SYSTEM, /one section per 250 words/);
});
