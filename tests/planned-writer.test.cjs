const { test } = require('node:test');
const assert = require('node:assert/strict');
const nim = require('../lib/nim.ts');
const { buildWritingPlan, composePlannedDraft, removeRepeatedProse } = require('../lib/planned-writer.ts');
const input = {topic:'Cell measurements', instructionText:'Evaluate the recorded measurements.', extraInstructions:'', wordTarget:600, minimumSources:10, minimumFootnotes:1, structureJson:JSON.stringify({thesis:'Assess the measurements.', sections:[{heading:'Cell measurements', paragraphs:[{point:'Evaluate the cell measurements under observed conditions.'}]}]})};
const sources = Array.from({length:10}, (_,i) => ({id:String(i+1), title:`Measurement study ${i+1}`, url:`https://example.org/study-${i+1}`, content:`Cell measurements in study ${i+1} recorded distinct observations under the experimental conditions described in the report.`}));
const overview = 'The recorded observations provide the basis for evaluating these measurements within the experimental conditions described. '.repeat(5);
const ending = 'This evaluation remains limited to the observations established in the discussion and does not extend the measurements beyond their recorded conditions. '.repeat(2);

test('ten required works are reserved before writing without forcing ten body paragraphs', () => {
  const plan = buildWritingPlan(input, sources);
  assert.equal(plan.requiredSourceIds.length, 10);
  assert.equal(plan.tasks.filter(task => task.role==='body').length, 2);
  assert.equal(buildWritingPlan({...input,minimumFootnotes:10},sources).tasks.filter(task=>task.role==='body').length,2);
  for (const task of plan.tasks) for (const fact of task.assigned) assert.ok(sources[fact.sourceId-1].content.includes(fact.text));
});

test('repetition is removed without discarding the original scope of a closing citation',()=>{
  const repeated='The study recorded a specific change in the observed measurements under its experimental conditions.';
  const fresh='The second observation concerned a different measurement recorded under the same experimental conditions.';
  const paragraphs=removeRepeatedProse([`${repeated}[^1]`,`${fresh} ${repeated}[^2]`]);
  assert.equal(paragraphs[0],`${repeated}[^1]`);
  assert.equal(paragraphs[1],`${fresh}[^2]`);
});

test('a paraphrased restatement within one paragraph is removed once its claim is developed',()=>{
  const first='East Harlem community projects expanded the urban tree canopy and created local green hubs, but persistent heat vulnerability showed that existing investment remained insufficient for long-term maintenance.';
  const second='East Harlem community-led initiatives created green hubs and expanded the tree canopy, while persistent heat vulnerability indicates that investment is insufficient for long-term maintenance and future canopy gains.';
  const result=removeRepeatedProse([`${first} ${second}[^5]`]);
  assert.match(result[0],/community projects expanded/);
  assert.doesNotMatch(result[0],/community-led initiatives/);
  assert.match(result[0],/\[\^5\]/);
});

test('planned prose omits self-referential scaffolding in any subject',()=>{
  assert.deepEqual(removeRepeatedProse(['The experiment recorded a change.[^2] The introduction sets out to evaluate the evidence.']),['The experiment recorded a change.[^2]']);
});

test('unavailable work minimum fails before a model call rather than after drafting', async () => {
  const original = nim.nimChatLong;
  let calls=0;
  nim.nimChatLong=async()=>{calls++;throw new Error('No request should be made');};
  try {
    await assert.rejects(composePlannedDraft(input,sources.slice(0,6)), /support 6 relevant distinct works/);
    assert.equal(calls,0);
  } finally {nim.nimChatLong=original;}
});

test('the complete source-planned essay is generated in one request with every reserved work', async () => {
  const original=nim.nimChatLong;
  let calls=0;
  nim.nimChatLong=async params=>{
    calls++;
    assert.equal(params.reasoningBudget,512);
    assert.equal(params.responseFormat.type,'json_schema');
    const plan=JSON.parse(params.user.split('\n\nOUTPUT FORMAT:')[0]);
    assert.equal(plan.requiredSourceIds.length,10);
    assert.match(params.system,/Each new paragraph must build on the paragraphs already written/);
    assert.match(params.system,/State a claim relevant to the question, develop one or two well-chosen source findings/);
    return JSON.stringify({title:'Measurements', paragraphs:[`${overview}【1】`,plan.requiredSourceIds.map(id=>`Study ${id} recorded cell measurements under observed conditions.【^${id}】`).join(' ')], conclusion:ending});
  };
  try {
    const draft=await composePlannedDraft({...input,wordTarget:200},sources);
    assert.equal(calls,1);
    assert.equal(draft.sections.length,1);
    assert.match(draft.sections[0].paragraphs[0],/\[\^10\]/);
    assert.doesNotMatch(draft.sections[0].paragraphs[0],/【/);
    assert.deepEqual(draft.evidence,[]);
    draft.introduction[0]='Mutated by a later audit.';
    const retry=await composePlannedDraft({...input,wordTarget:200},sources);
    assert.equal(calls,1,'Retrying an audit outage should reuse completed writing.');
    assert.notEqual(retry.introduction[0],draft.introduction[0],'Auditing must not mutate the cached prose.');
  } finally {nim.nimChatLong=original;}
});

test('a dropped full-essay stream falls back to smaller requests with prior paragraphs', async () => {
  const original = nim.nimChatLong;
  let calls = 0;
  let sawPrior = false;
  nim.nimChatLong = async params => {
    calls++;
    if (calls === 1) throw new Error('Model service error (read ECONNRESET). Try again in a bit.');
    const request = JSON.parse(params.user.split("\n")[0]);
    if (request.previousParagraphs.length) sawPrior = true;
    const pad='The pattern held across all observed groups.';
    const fill=(text,budget)=>{let out=text;while(out.split(/\s+/).filter(Boolean).length<Math.ceil(budget*0.65))out+=` ${pad}`;return out;};
    return JSON.stringify({ title: 'Measurements',
      paragraphs: request.tasks.map(task => fill(`${overview}${task.assigned.map(fact => `Study ${fact.sourceId} recorded cell measurements under observed conditions.[^${fact.sourceId}]`).join(' ')}`,task.words)),
      conclusion: request.conclusionWords ? fill(ending,request.conclusionWords) : '' });
  };
  try {
    const draft = await composePlannedDraft({ ...input, extraInstructions: 'Dropped stream fallback' }, sources);
    assert.ok(calls >= 3);
    assert.ok(sawPrior, 'the later request should see the paragraphs already written');
    assert.match(draft.sections[0].paragraphs.join(' '), /\[\^10\]/);
  } finally { nim.nimChatLong = original; }
});

test('long essays write in smaller groups with completed prose as context',async()=>{
  const original=nim.nimChatLong;
  let calls=0;
  let sawPrior=false;
  nim.nimChatLong=async params=>{
    calls++;
    const request=JSON.parse(params.user.split("\n")[0]);
    if(request.previousParagraphs.length) sawPrior=true;
    assert.match(params.system,/Do not include plans, word-count notes/);
    assert.match(params.system,/Do not stack facts, recite source sentences/);
    // Short filler stays under the duplication filter's substantial length.
    const pad='The pattern held across all observed groups.';
    const fill=(text,budget)=>{let out=text;while(out.split(/\s+/).filter(Boolean).length<Math.ceil(budget*0.65))out+=` ${pad}`;return out;};
    return JSON.stringify({title:'Measurements',paragraphs:request.tasks.map(task=>
      fill(`${overview}${task.assigned.map(fact=>`The recorded study examines cell measurements under its stated conditions.[^${fact.sourceId}]`).join(' ')}`,task.words)),
      conclusion:request.conclusionWords?fill(ending,request.conclusionWords):''});
  };
  try{
    const draft=await composePlannedDraft({...input,wordTarget:800,minimumSources:3,extraInstructions:'Long grouped writer test'},sources);
    assert.equal(calls,2);
    assert.ok(sawPrior);
    assert.ok(draft.sections.length);
  }finally{nim.nimChatLong=original;}
});

test('an omitted reserved work is explicitly repaired rather than silently accepting six of ten', async () => {
  const original=nim.nimChatLong;
  let calls=0;
  nim.nimChatLong=async params=>{
    const ids=++calls===1?[1,2,3,4,5,6]:[1,2,3,4,5,6,7,8,9,10];
    if(calls===2) { assert.match(params.user,/omitted reserved works/); for(const id of [7,8,9,10]) assert.ok(params.user.split('VALIDATION FAILURE:')[1].split('PREVIOUS RESPONSE:')[0].includes(String(id))); }
    return JSON.stringify({title:'Measurements',paragraphs:[`${overview}[^1]`,ids.map(id=>`The study describes cell measurements.[^${id}]`).join(' ')+overview],conclusion:ending});
  };
  try { await composePlannedDraft({...input,wordTarget:200,extraInstructions:'Explicit work repair test'},sources); assert.equal(calls,2); }
  finally {nim.nimChatLong=original;}
});

test('meeting the works floor does not regenerate merely to cite every available planned work',async()=>{
  const original=nim.nimChatLong;let calls=0;
  nim.nimChatLong=async params=>{
    calls++;
    const plan=JSON.parse(params.user.split('\n\nOUTPUT FORMAT:')[0]);
    assert.ok(plan.requiredSourceIds.length>3);
    const used=plan.requiredSourceIds.slice(0,-1);
    return JSON.stringify({title:'Floor test',paragraphs:plan.paragraphPlan.map((task,index)=> index===plan.paragraphPlan.length-1 ? used.map(id=>`Study ${id} recorded cell measurements under the experimental conditions described in the report.[^${id}]`).join(' ')+overview : `${overview}[^${used[0]}]`),conclusion:ending});
  };
  try{
    await composePlannedDraft({...input,wordTarget:200,minimumSources:3,minimumFootnotes:10,extraInstructions:'Works are a floor, not all gathered sources.'},sources);
    assert.equal(calls,1);
  }finally{nim.nimChatLong=original;}
});

test('an outline with its own introduction and conclusion yields one uncited conclusion, not a cited body section',async()=>{
  const original=nim.nimChatLong;
  const structureJson=JSON.stringify({thesis:'Evaluate the evidence.',sections:[
    {heading:'Introduction to the Topic',paragraphs:[{point:'Frame the research question.'}]},
    {heading:'Observed Measurements',paragraphs:[{point:'Evaluate the recorded measurements.'}]},
    {heading:'Conclusion: Overall Assessment',paragraphs:[{point:'Synthesize the established analysis.'}]}
  ]});
  nim.nimChatLong=async params=>{
    const plan=JSON.parse(params.user.split('\n\nOUTPUT FORMAT:')[0]);
    assert.deepEqual(plan.paragraphPlan.filter(task=>task.section>=0).map(task=>task.heading).filter((v,i,a)=>a.indexOf(v)===i),['Observed Measurements']);
    assert.match(plan.conclusionBrief,/Synthesize the established analysis/);
    return JSON.stringify({title:'Measurements',paragraphs:plan.paragraphPlan.map(()=>`${overview}[^1]`),conclusion:ending});
  };
  try{
    const draft=await composePlannedDraft({...input,wordTarget:200,minimumSources:1,minimumFootnotes:1,structureJson,extraInstructions:'Structural regression'},sources);
    assert.deepEqual(draft.sections.map(section=>section.heading),['Observed Measurements']);
    assert.equal(draft.conclusion.length,1);
    assert.doesNotMatch(draft.conclusion[0],/\[\^/);
  }finally{nim.nimChatLong=original;}
});

test('a body paragraph that masquerades as the conclusion is corrected before source auditing',async()=>{
  const original=nim.nimChatLong;let calls=0;
  nim.nimChatLong=async()=>JSON.stringify({title:'Measurements',paragraphs:[`${overview}[^1]`,`${++calls===1?'In conclusion, ':'The reported measurements suggest that '}${overview}[^1]`],conclusion:ending});
  try{
    const draft=await composePlannedDraft({...input,wordTarget:200,minimumSources:1,minimumFootnotes:1,extraInstructions:'Reject summary in body'},sources);
    assert.equal(calls,2);
    assert.doesNotMatch(draft.sections[0].paragraphs[0],/^In conclusion/);
  }finally{nim.nimChatLong=original;}
});

test('piled limitation sentences are rewritten during drafting',async()=>{
  const original=nim.nimChatLong;
  let calls=0, sawLimitationFeedback=false;
  const pad='The pattern held across all observed groups.';
  const fill=(text,budget)=>{let out=text;while(out.split(/\s+/).filter(Boolean).length<Math.ceil(budget*0.55))out+=` ${pad}`;return out;};
  const piled='The evidence does not establish long-term outcomes for this intervention. The supplied findings cannot settle questions of scale across regions.';
  nim.nimChatLong=async params=>{
    calls++;
    const request=JSON.parse(params.user.split("\n")[0]);
    const repairing=params.user.includes('evidence limits');
    if(repairing) sawLimitationFeedback=true;
    return JSON.stringify({title:'Measurements',paragraphs:request.tasks.map(task=>{
      const base=`${overview}${task.assigned.map(fact=>`The recorded study examines cell measurements under its stated conditions.[^${fact.sourceId}]`).join(' ')}`;
      const filled=fill(base,task.words);
      return repairing?filled:`${filled} ${piled}`;
    }),conclusion:request.conclusionWords?fill(ending,request.conclusionWords):''});
  };
  try{
    const draft=await composePlannedDraft({...input,wordTarget:800,minimumSources:1,minimumFootnotes:1,extraInstructions:'Limitation cap test'},sources);
    assert.ok(calls>=2);
    assert.ok(sawLimitationFeedback,'the retry should carry the limitation feedback');
    for(const paragraph of [...draft.introduction,...draft.sections.flatMap(s=>s.paragraphs)]){
      const hits=paragraph.split(/(?<=[.!?])\s+/).filter(s=>/does not establish|cannot settle/i.test(s)).length;
      assert.ok(hits<=1);
    }
  }finally{nim.nimChatLong=original;}
});
