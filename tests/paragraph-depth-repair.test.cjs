const {test}=require('node:test');
const assert=require('node:assert/strict');
const nim=require('../lib/nim.ts');
const grounding=require('../lib/grounding-audit.ts');
const {repairParagraphDepth}=require('../lib/paragraph-depth-repair.ts');

test('thin verified sections receive independently checked unused evidence without rewriting existing prose',async()=>{
  const source={id:'1',title:'Urban tree study',url:'https://example.org/urban-trees',
    content:'Urban trees reduce stormwater runoff by intercepting rainfall and improving water infiltration in planted areas.'};
  const draft={title:'Urban trees',introduction:['Urban trees affect city planning.'],
    sections:[{heading:'Urban tree stormwater benefits',paragraphs:['Urban trees are part of city infrastructure.']}],
    conclusion:['Their value depends on local implementation.'],footnotes:[],evidence:[],worksCited:[],coverage:[]};
  const original=structuredClone(draft);
  const input={topic:'Urban tree stormwater benefits',instructionText:'Discuss benefits.',extraInstructions:'',wordTarget:500,
    structureJson:JSON.stringify({sections:[{heading:'Urban tree stormwater benefits',paragraphs:[{point:'Describe stormwater benefits.'}]}]})};
  const oldChat=nim.nimChatLong,oldAudit=grounding.auditAndAlignGrounding;
  let audited=0;
  nim.nimChatLong=async params=>{
    const request=JSON.parse(params.user);
    assert.equal(request.slots.length,1);
    assert.equal(request.slots[0].text,source.content);
    return JSON.stringify({additions:['The observed trees intercepted rainfall and improved infiltration in planted areas, which reduced stormwater runoff.[^1]']});
  };
  grounding.auditAndAlignGrounding=async supplement=>{
    audited++;
    supplement.evidence=[{paragraph:0,source:1,quote:source.content}];
    supplement.footnotes=[{...source,id:1}];
    return {removed:[]};
  };
  try{
    assert.equal(await repairParagraphDepth(draft,input,[source]),true);
    assert.equal(audited,1);
    assert.equal(draft.introduction[0],original.introduction[0]);
    assert.equal(draft.conclusion[0],original.conclusion[0]);
    assert.match(draft.sections[0].paragraphs[0],/intercepted rainfall/);
    assert.equal(draft.evidence[0].paragraph,1);
  }finally{nim.nimChatLong=oldChat;grounding.auditAndAlignGrounding=oldAudit;}
});

test('a large deficit reserves several new findings across thin sections',async()=>{
  const sources=[
    'Wetland flood storage temporarily holds water during storms and lowers downstream peak flows in connected catchments.',
    'Wetland vegetation slows flood runoff and traps sediment before water reaches downstream communities.',
    'Wetland restoration limits include altered hydrology that prevents native plants from establishing at a site.',
    'Wetland restoration limits include continuing maintenance needed to control invasive species after planting.',
  ].map((content,index)=>({id:String(index+1),title:`Source ${index+1}`,url:`https://example.org/${index+1}`,content}));
  const draft={title:'Wetlands',introduction:['A question about wetlands.'],sections:[
    {heading:'Wetland flood benefits',paragraphs:['The first section considers flood benefits.']},
    {heading:'Wetland restoration limits',paragraphs:['The second section considers restoration limits.']},
  ],conclusion:['A qualified conclusion.'],footnotes:[],evidence:[],worksCited:[],coverage:[]};
  const originalChat=nim.nimChatLong,originalAudit=grounding.auditAndAlignGrounding;
  let reserved=0;
  nim.nimChatLong=async params=>{
    const request=JSON.parse(params.user);
    reserved=request.slots.length;
    return JSON.stringify({additions:request.slots.map(slot=>`${slot.text}[^${slot.sourceId}]`)});
  };
  grounding.auditAndAlignGrounding=async supplement=>{
    supplement.evidence=supplement.sections.map((_,index)=>({paragraph:index,source:index+1,quote:sources[index].content}));
    supplement.footnotes=sources.map((source,index)=>({...source,id:index+1}));
    return {removed:[]};
  };
  try{
    assert.equal(await repairParagraphDepth(draft,{topic:'Wetland flooding and restoration',instructionText:'',extraInstructions:'',wordTarget:800,structureJson:'{}'},sources),true);
    assert.equal(reserved,4);
    assert.ok(draft.sections.every(section=>section.paragraphs[0].includes('[^')));
  }finally{nim.nimChatLong=originalChat;grounding.auditAndAlignGrounding=originalAudit;}
});
