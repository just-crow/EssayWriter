const {test}=require('node:test');
const assert=require('node:assert/strict');
const nim=require('../lib/nim.ts');
const grounding=require('../lib/grounding-audit.ts');
const {repairCitationMinimums}=require('../lib/citation-repair.ts');
const {citationCounts}=require('../lib/citation-limits.ts');

test('eight verified works are repaired to ten without rewriting or re-auditing existing prose',async()=>{
  const sources=Array.from({length:10},(_,i)=>({id:String(i+1),title:`Measurement study ${i+1}`,url:`https://example.org/study-${i+1}`,content:`Cell measurements in study ${i+1} recorded distinct observations under the experimental conditions described in the report.`}));
  const draft={title:'Measurements',introduction:['The introduction stays unchanged.[^1]'],sections:[{heading:'Cell measurements',paragraphs:[Array.from({length:14},(_,i)=>`Established observation ${i+1} remains supported.[^${i%8+1}]`).join(' ')]}],conclusion:['The conclusion stays unchanged.'],footnotes:sources.slice(0,8).map(s=>({...s,id:Number(s.id)})),evidence:[{paragraph:1,source:1,quote:sources[0].content}],worksCited:[],coverage:[]};
  const before=structuredClone(draft);
  const input={topic:'Cell measurements',instructionText:'Evaluate measurements.',extraInstructions:'',wordTarget:600,minimumSources:10,minimumFootnotes:10,structureJson:JSON.stringify({thesis:'Assess measurements.',sections:[{heading:'Cell measurements',paragraphs:[{point:'Evaluate the cell measurements under observed conditions.'}]}]})};
  const originalChat=nim.nimChatLong,originalAudit=grounding.auditAndAlignGrounding;
  let writingCalls=0,auditCalls=0;
  nim.nimChatLong=async params=>{
    writingCalls++;
    const request=JSON.parse(params.user.split('\n\nVALIDATION FAILURE:')[0]);
    assert.deepEqual(request.slots.map(slot=>slot.sourceId).sort((a,b)=>a-b),[9,10]);
    assert.deepEqual(request.verifiedEssay.conclusion,before.conclusion);
    return JSON.stringify({additions:request.slots.map(slot=>`Study ${slot.sourceId} recorded cell measurements under its reported experimental conditions.[^${slot.sourceId}]`)});
  };
  grounding.auditAndAlignGrounding=async supplement=>{
    auditCalls++;
    assert.equal(supplement.introduction.length,0);
    assert.equal(supplement.conclusion.length,0);
    assert.equal(supplement.sections.length,2);
    supplement.evidence=supplement.sections.map((s,i)=>({paragraph:i,source:Number(s.paragraphs[0].match(/\[\^(\d+)\]/)[1]),quote:sources[Number(s.paragraphs[0].match(/\[\^(\d+)\]/)[1])-1].content}));
    return {removed:[]};
  };
  try {
    assert.deepEqual(citationCounts(draft),{footnotes:15,works:8});
    await repairCitationMinimums(draft,input,sources);
    assert.equal(writingCalls,1);assert.equal(auditCalls,1);
    assert.equal(citationCounts(draft).works,10);
    assert.ok(citationCounts(draft).footnotes>=10);
    assert.deepEqual(draft.introduction,before.introduction);
    assert.deepEqual(draft.conclusion,before.conclusion);
    const prose=text=>text.replace(/\[\^\d+\]/g,'');
    assert.ok(prose(draft.sections[0].paragraphs[0]).startsWith(prose(before.sections[0].paragraphs[0])));
    for(const anchor of draft.evidence){
      assert.equal(anchor.paragraph,1);
      const note=draft.footnotes.find(n=>n.id===anchor.source);
      assert.ok(sources.find(s=>s.url===note.url).content.includes(anchor.quote));
    }
  }finally{nim.nimChatLong=originalChat;grounding.auditAndAlignGrounding=originalAudit;}
});
