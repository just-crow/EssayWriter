const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ensureEssayEnds}=require('../lib/essay-endings.ts');

test('an audit can empty an opening without discarding a verified essay',()=>{
  const draft={introduction:[''],sections:[{heading:'Causes',paragraphs:['The measured change was reported.[^1]']},
    {heading:'Limits',paragraphs:['The result had stated limits.[^2]']}],conclusion:[''],footnotes:[],worksCited:[],evidence:[],coverage:[]};
  ensureEssayEnds(draft,'How these changes affect cities');
  assert.match(draft.introduction[0],/examines how these changes affect cities/);
  assert.match(draft.conclusion[0],/findings already presented/);
  assert.doesNotMatch([...draft.introduction,...draft.conclusion].join(' '),/\[\^\d+\]/);
  assert.equal(draft.sections[0].paragraphs[0],'The measured change was reported.[^1]');
});

test('verified opening and conclusion remain unchanged',()=>{
  const draft={introduction:['A verified opening.[^1]'],sections:[],conclusion:['A qualified final judgment.'],footnotes:[],worksCited:[],evidence:[],coverage:[]};
  ensureEssayEnds(draft,'A topic');
  assert.deepEqual(draft.introduction,['A verified opening.[^1]']);
  assert.deepEqual(draft.conclusion,['A qualified final judgment.']);
});

test('a removed lead sentence does not leave an orphaned introductory reference',()=>{
  const draft={introduction:['These challenges shape the outcome.'],sections:[{heading:'Evidence',paragraphs:['A verified body.']}],
    conclusion:['A qualified result.'],footnotes:[],worksCited:[],evidence:[],coverage:[]};
  ensureEssayEnds(draft,'How a project can succeed');
  assert.match(draft.introduction[0],/^The discussion examines how a project can succeed\. These challenges/);
});
