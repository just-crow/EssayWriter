const {test}=require('node:test');
const assert=require('node:assert/strict');
const nim=require('../lib/nim.ts');
const {removeOffTopicProse}=require('../lib/topic-relevance.ts');

test('removes a well-cited but unrelated example while preserving citation scope for relevant claims',async()=>{
  const draft={title:'Crop essay',introduction:['The plant study recorded a crop response.[^1]'],
    sections:[{heading:'Adoption of Crops',paragraphs:[
      'Public acceptance affects adoption. An animal product received regulatory review. The meat was offered for sale.[^2] Crop regulations differ across countries.[^3]'
    ]}],conclusion:['The established crop findings warrant careful review.'],footnotes:[],evidence:[],worksCited:[],coverage:[]};
  const original=nim.nimChatLong;
  nim.nimChatLong=async params=>{
    assert.match(params.user,/ESSAY TOPIC: Crop improvement/);
    assert.match(params.user,/Adoption of Crops/);
    assert.match(params.user,/Evaluate adoption of crop products/);
    const batch=JSON.parse(params.user.split('SENTENCES TO CHECK: ')[1].split('\nReturn ')[0]);
    return JSON.stringify({decisions:batch.flatMap(item=>item.sentences.map(sentence=>({
      paragraph:item.paragraph,sentenceIndex:sentence.sentenceIndex,
      relevant:!(item.paragraph===1 && [1,2].includes(sentence.sentenceIndex)),
      reason:'Relevance checked.'
    })))});
  };
  try{
    const removed=await removeOffTopicProse(draft,'Crop improvement',undefined,JSON.stringify({sections:[{heading:'Adoption of Crops',paragraphs:[{point:'Evaluate adoption of crop products.'}]}]}));
    assert.equal(removed.length,2);
    assert.doesNotMatch(draft.sections[0].paragraphs[0],/animal|meat/i);
    assert.match(draft.sections[0].paragraphs[0],/Public acceptance affects adoption\.\[\^2\]/);
    assert.match(draft.sections[0].paragraphs[0],/Crop regulations differ across countries\.\[\^3\]/);
    assert.deepEqual(draft.conclusion,['The established crop findings warrant careful review.']);
  }finally{nim.nimChatLong=original;}
});

test('the introduction is never reviewed or removed for topicality',async()=>{
  const draft={title:'Crop essay',introduction:[' framing statement about crops.[^1]'],
    sections:[{heading:'Adoption of Crops',paragraphs:['Public acceptance affects adoption.[^2]']}],
    conclusion:['Closing.'],footnotes:[],evidence:[],worksCited:[],coverage:[]};
  const original=nim.nimChatLong;
  let minParagraph = Infinity;
  nim.nimChatLong=async params=>{
    const batch=JSON.parse(params.user.split('SENTENCES TO CHECK: ')[1].split('\nReturn ')[0]);
    for (const item of batch) minParagraph = Math.min(minParagraph, item.paragraph);
    return JSON.stringify({decisions:batch.flatMap(item=>item.sentences.map(sentence=>({
      paragraph:item.paragraph,sentenceIndex:sentence.sentenceIndex,
      relevant:false,reason:'Off topic.'
    })))});
  };
  try{
    // Even with the model flagging everything, the framing intro survives;
    // only body sentences go, keeping global paragraph numbering intact.
    const removed=await removeOffTopicProse(draft,'Crop improvement');
    assert.ok(minParagraph >= 1, 'introduction never reaches the reviewer');
    assert.equal(removed.length,1);
    assert.match(removed[0],/^paragraph 1:/);
    assert.deepEqual(draft.introduction,['framing statement about crops.[^1]']);
  }finally{nim.nimChatLong=original;}
});
