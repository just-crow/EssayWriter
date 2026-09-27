const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STRUCTURE_SYSTEM, DRAFT_SYSTEM, REFINE_SYSTEM, structureUserPrompt, draftUserPrompt } = require('../lib/prompts.ts');

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
