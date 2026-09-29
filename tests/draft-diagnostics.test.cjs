const {test}=require('node:test');
const assert=require('node:assert/strict');
const {snapshotDraft,plannedEvidence}=require('../lib/draft-diagnostics.ts');

test('draft trace records section word loss and the evidence given to the writer',()=>{
  const draft={title:'Sample',introduction:['One two.[^1]'],sections:[{heading:'Benefits',paragraphs:['Three four five.[^2]']}],
    conclusion:['Six seven.'],footnotes:[],worksCited:[],evidence:[],coverage:[]};
  const before=snapshotDraft(draft,'Writer');
  draft.sections[0].paragraphs=['Three four.[^2]'];
  const after=snapshotDraft(draft,'Source verification');
  assert.equal(before.words,7);
  assert.equal(after.words,6);
  assert.deepEqual(after.parts.map(part=>part.words),[2,2,2]);
  const plan=plannedEvidence([{section:0,words:90,assigned:[{sourceId:1},{sourceId:2}]}],['Benefits']);
  assert.deepEqual(plan,[{heading:'Benefits',targetWords:90,findings:2,works:2}]);
});
