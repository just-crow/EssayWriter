const {test}=require('node:test');
const assert=require('node:assert/strict');
const nim=require('../lib/nim.ts');
const {buildWritingPlan,composePlannedDraft}=require('../lib/planned-writer.ts');

const cases=[
  {topic:'Freshwater wetlands and flood risk',sections:['Floodwater storage','Restoration limitations'],facts:[
    'Freshwater wetlands provide floodwater storage during storms and reduce downstream peak flows in connected catchments.',
    'Wetland floodwater storage benefits from vegetation that slows runoff and reduces sediment transport during seasonal floods.',
    'Wetland restoration limitations include unsuitable hydrology because altered water levels can prevent native plants from establishing.',
    'Wetland restoration limitations include long-term monitoring and maintenance to control invasive species after planting.',
  ]},
  {topic:'Urban trees and city planning',sections:['Environmental benefits','Planning limitations'],facts:[
    'Environmental benefits of urban trees include rainfall interception and reduced stormwater runoff from paved streets during heavy rain.',
    'Environmental benefits of tree shade include lower summer surface temperatures in streets and public spaces.',
    'Urban tree planning limitations include continuing maintenance funding for pruning and replacement of dead trees.',
    'City planning limitations include coordination of tree planting with underground utilities and street design.',
  ]},
  {topic:'Printing press and early modern Europe',sections:['Spread of printed books','Limits on access'],facts:[
    'The spread of printed books accelerated because printing presses produced texts faster than manuscript copying in European cities.',
    'The spread of printed books and pamphlets circulated religious and political arguments across European towns.',
    'Limits on access included the cost of printed books for poorer readers in early modern Europe.',
    'Limits on access also included literacy and distribution networks outside major European cities.',
  ]},
];

test('unrelated essay topics receive section-specific observed findings before writing',()=>{
  for(const item of cases){
    const sources=item.facts.map((content,index)=>({id:String(index+1),title:`Document ${index+1}`,
      url:`https://example.org/${index+1}-${item.sections[index<2?0:1].replace(/\s+/g,'-')}`,content}));
    const structureJson=JSON.stringify({thesis:item.topic,sections:item.sections.map(heading=>({heading,paragraphs:[{point:`Assess ${heading.toLowerCase()} using documented evidence.`}]}))});
    const plan=buildWritingPlan({topic:item.topic,wordTarget:600,minimumSources:3,minimumFootnotes:3,
      instructionText:'',extraInstructions:'',structureJson},sources);
    assert.ok(new Set(plan.tasks.flatMap(task=>task.assigned.map(finding=>finding.sourceId))).size>=3,item.topic);
    for(const task of plan.tasks.filter(task=>task.role==='body')){
      assert.ok(task.assigned.length>=2,`${item.topic}: ${task.point} ${JSON.stringify(plan.tasks.map(entry=>({section:entry.section,assigned:entry.assigned.map(finding=>finding.text)})))}`);
      for(const finding of task.assigned) assert.ok(sources[finding.sourceId-1].content.includes(finding.text));
    }
  }
});

test('the writer receives and cites section-specific evidence for unrelated subjects',async()=>{
  const original=nim.nimChatLong;
  nim.nimChatLong=async params=>{
    const request=JSON.parse(params.user.split('\n\nOUTPUT FORMAT:')[0]);
    assert.ok(request.paragraphPlan.every(task=>task.assigned.length));
    return JSON.stringify({title:request.topic,paragraphs:request.paragraphPlan.map(task=>{
      const findings=task.assigned.map(finding=>`${finding.text}[^${finding.sourceId}]`).join(' ');
      return `The discussion of ${task.heading.toLowerCase()} draws on the documented findings. ${findings} These observations give this part of the argument a concrete basis while limiting its reach to what the selected pages establish.`;
    }),conclusion:`The supplied evidence supports a qualified assessment of ${request.topic.toLowerCase()}. The body develops its separate questions through the documented findings, so the closing assessment stays within those findings and introduces no additional factual claim.`});
  };
  try{
    for(const item of cases){
      const sources=item.facts.map((content,index)=>({id:String(index+1),title:`Document ${index+1}`,
        url:`https://example.org/${index+1}-${item.sections[index<2?0:1].replace(/\s+/g,'-')}`,content}));
      const structureJson=JSON.stringify({thesis:item.topic,sections:item.sections.map(heading=>({heading,paragraphs:[{point:`Assess ${heading.toLowerCase()} using documented evidence.`}]}))});
      const draft=await composePlannedDraft({topic:item.topic,wordTarget:300,minimumSources:3,minimumFootnotes:3,
        instructionText:'',extraInstructions:'',structureJson},sources);
      assert.deepEqual(draft.sections.map(section=>section.heading),item.sections);
      assert.ok(new Set(draft.sections.flatMap(section=>section.paragraphs).flatMap(text=>[...text.matchAll(/\[\^(\d+)\]/g)].map(match=>match[1]))).size>=3,item.topic);
      assert.doesNotMatch(draft.conclusion.join(' '),/\[\^\d+\]/);
    }
  }finally{nim.nimChatLong=original;}
});
