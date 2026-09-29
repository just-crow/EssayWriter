const { test } = require('node:test');
const assert = require('node:assert/strict');
const nim = require('../lib/nim.ts');
const { auditAndAlignGrounding } = require('../lib/grounding-audit.ts');
const { selectWritingEvidence } = require('../lib/evidence-plan.ts');
const { evidenceSpine } = require('../lib/evidence-spine.ts');
const { prepareDraft, sourcesTextMap, verifyEvidence, consolidateSectionParagraphs, uncoveredClaimTerms } = require('../lib/validate.ts');

test('interactive learning is not the named method active learning, and explicit design aims remain proposals', async () => {
  const url = 'https://example.edu/course';
  const content = 'The course teaches mathematical proof techniques to incoming computer science students through logic and sets.';
  const fact = 'The course teaches mathematical proof techniques, relevant to the proposed interactive learning platform.';
  const proposal = 'I propose that the platform should provide a workspace to help learners record their reasoning.';
  const falseResearch = 'I propose this feature because research shows it improves student engagement.';
  const draft = { title: 'Platform', introduction: [], sections: [{ heading: 'Design', paragraphs: [`${fact}[^1] ${proposal} ${falseResearch}`] }], conclusion: [], footnotes: [{ id: 1, url }], evidence: [], worksCited: [], coverage: [] };
  const original = nim.nimChatLong;
  nim.nimChatLong = async () => JSON.stringify({ claims: [
    { paragraph: 0, sentenceIndex: 0, status: 'supported', supportingSourceIndex: 0, supportingPassageIndexes: [0], reason: 'Course facts followed by topic relevance.' },
    { paragraph: 0, sentenceIndex: 1, status: 'nonfactual', reason: 'Explicit proposed design aim.' },
    { paragraph: 0, sentenceIndex: 2, status: 'nonfactual', reason: 'Incorrectly exempted research assertion.' },
  ] });
  try {
    const result = await auditAndAlignGrounding(draft, [{ url, content, title: 'Course', author: '', publisher: '', year: '', accessed: '27 Sep 2026' }]);
    assert.equal(result.removed.length, 1);
    assert.ok(draft.sections[0].paragraphs[0].includes(fact));
    assert.ok(draft.sections[0].paragraphs[0].includes(proposal));
    assert.ok(!draft.sections[0].paragraphs[0].includes(falseResearch));
  } finally { nim.nimChatLong = original; }
});

test('prewriting selection uses actual relevant passages without asking the model to invent indexes', async () => {
  const sources = [
    { url: 'https://example.org/useful', content: 'A first factual passage about the curriculum.\nThe selected passage explains a mathematics requirement.' },
    { url: 'https://example.org/unused', content: 'This other source is unrelated to the essay topic.' },
  ];
  const original = nim.nimChatLong;
  try {
    nim.nimChatLong = async () => { throw new Error('Passage selection must not depend on model indexes.'); };
    const selected = await selectWritingEvidence(sources, 'Explain mathematics requirements.');
    assert.equal(selected.length, 1);
    assert.equal(selected[0].url, sources[0].url);
    assert.equal(selected[0].content, 'The selected passage explains a mathematics requirement.');

    const recovered = await selectWritingEvidence(sources, 'Explain mathematics requirements.');
    assert.ok(recovered.length > 0);
    assert.ok(recovered.every(source => sources.find(original => original.url === source.url).content.includes(source.content)));
    assert.ok(recovered[0].content.includes('mathematics requirement'));

    const mixed = await selectWritingEvidence(sources, 'Explain mathematics requirements.', { minimumSources: 2 });
    assert.equal(new Set(mixed.map(source => source.url)).size, 2);
    assert.ok(mixed.every(source => source.content.split('\n\n').every(passage => sources.find(original => original.url === source.url).content.includes(passage))));

    assert.ok((await selectWritingEvidence(sources, 'Explain mathematics requirements.')).length > 0);
  } finally { nim.nimChatLong = original; }
});

test('the prewriting evidence spine contains only observed findings from selected pages', () => {
  const content='The mathematics course asks students to construct formal proofs and explain their reasoning through collaborative work. The curriculum survey identifies probability and statistics as important mathematical subjects for computing education.';
  const primary={id:'4',url:'https://example.edu/course',content};
  const unrelated={id:'8',url:'https://example.com/catalog',content:'The catalog lists many different courses and certificates with numerous enrollment options for students.'};
  const facts=JSON.parse(evidenceSpine([{...primary,content:content+' The platform is proven to improve every learning outcome for all students in all subjects.'},unrelated],[primary,unrelated]));
  assert.equal(facts.length,2);
  for(const fact of facts){assert.equal(fact.sourceId,'4');assert.ok(content.includes(fact.text));}
});

test('malformed writer quotes are verified against original citations without assigning replacement sources', async () => {
  const url = 'https://example.org/study';
  const otherUrl = 'https://example.org/unused';
  const content = 'The study observed improved scores after practice.';
  const sources = [url, otherUrl].map((url) => ({ url, content, title: 'Study', author: '', publisher: '', year: '', accessed: '27 Sep 2026' }));
  const draft = {
    title: 'Practice', introduction: ['The study observed improved scores after practice.[^1]'],
    sections: [{ heading: 'Results', paragraphs: ['A fabricated detail.[^1] Another invented result.[^1] Research indicates that active learning improves student engagement.'] }],
    conclusion: ['This warrants further investigation.'],
    footnotes: [{ id: 1, url, title: 'Study' }], worksCited: [], coverage: [],
    evidence: [{ paragraph: 0, source: 1, quote: 'Not present on the page.' }],
  };
  prepareDraft(draft, sourcesTextMap(sources), { deferEvidence: true });
  const original = nim.nimChatLong;
  nim.nimChatLong = async (request) => {
    if (JSON.parse(request.user.split('ESSAY PARAGRAPHS AND SENTENCES:\n')[1].split('\n\nReturn')[0]).some(p => p.paragraph === 0)) assert.ok(request.user.includes(`"urls":["${url}"]`), 'the auditor receives complete original citation URLs');
    return JSON.stringify({ claims: [
    { paragraph: 0, sentenceIndex: 0, status: 'supported', supportingSourceIndex: 0, supportingPassageIndexes: [0], reason: 'Direct finding.' },
    { paragraph: 1, sentence: 'A fabricated detail.', status: 'supported', supportingUrl: otherUrl, supportingQuote: content, reason: 'Wrong source selected.' },
    { paragraph: 1, sentence: 'Another invented result.', status: 'supported', supportingUrl: url, supportingQuote: 'An invented supporting quotation.', reason: 'Invented quote.' },
    { paragraph: 1, sentence: 'Research indicates that active learning improves student engagement.', status: 'nonfactual', reason: 'Analysis.' },
    { paragraph: 2, sentence: 'This warrants further investigation.', status: 'nonfactual', reason: 'Recommendation.' },
  ] });
  };
  try {
    const audit = await auditAndAlignGrounding(draft, sources);
    assert.equal(audit.removed.length, 3);
    assert.equal(draft.sections[0].paragraphs[0], '');
    assert.deepEqual(draft.footnotes.map((note) => note.url), [url]);
    assert.deepEqual(verifyEvidence(draft.evidence, draft.footnotes, sourcesTextMap(sources)), []);
  } finally { nim.nimChatLong = original; }
});

test('paragraph consolidation preserves section boundaries and evidence locations', () => {
  const developed = 'This sentence develops the point with evidence and careful consideration. '.repeat(8);
  const draft = {
    introduction: ['Intro.[^1]'], conclusion: ['Conclusion.[^4]'],
    sections: [
      { heading: 'One', paragraphs: [`${developed}[^2]`] },
      { heading: 'Two', paragraphs: ['Short paragraph.[^3]'] },
    ],
    evidence: [1, 2, 3, 4].map((source, paragraph) => ({ paragraph, source, quote: 'A verified source passage.' })),
  };
  consolidateSectionParagraphs(draft);
  assert.equal(draft.sections.length, 2);
  assert.equal(draft.sections[1].heading, 'Two');
  assert.equal(draft.sections[1].paragraphs[0], 'Short paragraph.[^3]');
  const paragraphs = [...draft.introduction, ...draft.sections.flatMap((section) => section.paragraphs), ...draft.conclusion];
  for (const evidence of draft.evidence) assert.ok(paragraphs[evidence.paragraph].includes(`[^${evidence.source}]`));
});

test('incomplete audit batches are repaired instead of deleting unchecked supported sentences', async () => {
  const url = 'https://example.org/cells';
  const content = 'The textbook describes cells as the smallest structural and functional units of living organisms.';
  const draft = { title: 'Cells', introduction: [`${content}[^1]`], sections: [{ heading: 'Structure', paragraphs: [`${content}[^1]`, `${content}[^1]`] }], conclusion: [], footnotes: [{ id: 1, url }], evidence: [], worksCited: [], coverage: [] };
  const original = nim.nimChatLong;
  let repaired = false;
  const batchSizes = [];
  nim.nimChatLong = async request => {
    const batch = JSON.parse(request.user.split('ESSAY PARAGRAPHS AND SENTENCES:\n')[1].split('\n\nReturn')[0]);
    batchSizes.push(batch.length);
    if (batch.length === 2 && !request.user.includes('VALIDATION FAILURE:')) return JSON.stringify({ claims: [] });
    if (request.user.includes('VALIDATION FAILURE:')) {
      repaired = true;
      assert.match(request.user, /Missing audit entries are not evidence/);
    }
    return JSON.stringify({ claims: batch.flatMap(paragraph => paragraph.sentences.map(sentence => ({ paragraph: paragraph.paragraph, sentenceIndex: sentence.sentenceIndex, status: 'supported', supportingSourceIndex: 0, supportingPassageIndexes: [0], reason: 'The original page directly states this finding.' }))) });
  };
  try {
    const result = await auditAndAlignGrounding(draft, [{ url, content, title: 'Textbook', author: '', publisher: '', year: '', accessed: '' }]);
    assert.ok(repaired);
    assert.ok(batchSizes.every(size => size <= 2));
    assert.deepEqual(result.removed, []);
    assert.equal(draft.footnotes.length, 3);
    assert.ok(draft.sections[0].paragraphs[1].includes(content));
  } finally { nim.nimChatLong = original; }
});

test('one grouped paragraph footnote retains verification of every sentence', async () => {
  const url = 'https://example.org/curriculum';
  const content = 'The course covers mathematical proofs. The course includes weekly problem sets.';
  const sources = [{url, content, title:'Curriculum', author:'', publisher:'', year:'', accessed:'27 Sep 2026'}];
  const draft = { title:'Curriculum', introduction:[], sections:[{heading:'Course',paragraphs:[`${content}[^1]`]}], conclusion:[], footnotes:[{id:1,url}], evidence:[], worksCited:[], coverage:[] };
  const original = nim.nimChatLong;
  nim.nimChatLong = async (request) => {
    const paragraphs = JSON.parse(request.user.split('ESSAY PARAGRAPHS AND SENTENCES:\n')[1].split('\n\nReturn')[0]);
    assert.deepEqual(paragraphs[0].citedSources.map((sentence)=>sentence.urls), [[url],[url]]);
    return JSON.stringify({claims:[0,1].map((sentenceIndex)=>({paragraph:0,sentenceIndex,status:'supported',supportingSourceIndex:0,supportingPassageIndexes:[0],reason:'Direct course description.'}))});
  };
  try {
    await auditAndAlignGrounding(draft,sources);
    assert.equal(draft.footnotes.length,1);
    assert.ok(!draft.sections[0].paragraphs[0].includes('proofs.[^'));
    assert.ok(draft.sections[0].paragraphs[0].includes('sets.[^1]'));
    assert.deepEqual(verifyEvidence(draft.evidence,draft.footnotes,sourcesTextMap(sources)),[]);
  } finally { nim.nimChatLong = original; }
});

test('dense audit indexes map back to the original cited pages across batches', async () => {
  const contents = ['The first study recorded temperature measurements during its experimental observation period.', 'The second study recorded humidity measurements during its experimental observation period.'];
  const urls = ['https://example.org/temperature','https://example.org/humidity'];
  const sources = urls.map((url,i)=>({url,content:contents[i],title:`Study ${i}`,author:'',publisher:'',year:'',accessed:''}));
  const draft = {title:'Measurements',introduction:[`${contents[0]}[^1]`],sections:[{heading:'Humidity',paragraphs:[`${contents[1]}[^2]`]}],conclusion:[],footnotes:urls.map((url,i)=>({id:i+1,url})),evidence:[],worksCited:[],coverage:[]};
  const original=nim.nimChatLong;
  let calls=0;
  nim.nimChatLong=async request=>{
    calls++;
    const pages=JSON.parse(request.user.split('SOURCES:\n')[1].split('\n\nESSAY PARAGRAPHS')[0]);
    assert.equal(pages.length,1); assert.equal(pages[0].sourceIndex,0);
    const batch=JSON.parse(request.user.split('ESSAY PARAGRAPHS AND SENTENCES:\n')[1].split('\n\nReturn')[0]);
    return JSON.stringify({claims:[{paragraph:batch[0].paragraph,sentenceIndex:0,status:'supported',supportingSourceIndex:0,supportingPassageIndexes:[0],reason:'Direct measurement.'}]});
  };
  try {
    const result=await auditAndAlignGrounding(draft,sources,{batchSize:1,fast:true});
    assert.equal(calls,2); assert.deepEqual(result.removed,[]);
    assert.deepEqual(draft.footnotes.map(note=>note.url),urls);
    assert.deepEqual(verifyEvidence(draft.evidence,draft.footnotes,sourcesTextMap(sources)),[]);
  } finally {nim.nimChatLong=original;}
});

test('large-page verification retrieves late evidence and keeps the model request bounded', async () => {
  const url='https://example.org/large-late-evidence';
  const finding='The drought experiment recorded a nineteen percent reduction in water consumption in edited rice plants.';
  const content=Array.from({length:140},(_,i)=>`Unrelated historical background entry ${i} describes ancient pottery and archaeological excavation methods. `.repeat(8)).join('\n')+'\n'+finding;
  assert.ok(content.indexOf(finding)>100000);
  const draft={title:'Rice',introduction:[],sections:[{heading:'Drought',paragraphs:[`${finding}[^1]`]}],conclusion:[],footnotes:[{id:1,url}],evidence:[],worksCited:[],coverage:[]};
  const original=nim.nimChatLong;
  nim.nimChatLong=async request=>{
    const pages=JSON.parse(request.user.split('SOURCES:\n')[1].split('\n\nESSAY PARAGRAPHS')[0]);
    assert.ok(pages[0].passages.reduce((n,p)=>n+p.text.length,0)<=48000);
    const passage=pages[0].passages.find(p=>p.text.includes(finding));
    assert.ok(passage,'Relevant evidence beyond the former page cap must be supplied.');
    assert.deepEqual(pages[0].passages.map(p=>p.passageIndex),pages[0].passages.map((_,i)=>i));
    return JSON.stringify({claims:[{paragraph:0,sentenceIndex:0,status:'supported',supportingSourceIndex:0,supportingPassageIndexes:[passage.passageIndex],reason:'Direct experiment result.'}]});
  };
  try{
    assert.deepEqual((await auditAndAlignGrounding(draft,[{url,content,title:'Rice experiment',author:'',publisher:'',year:'',accessed:''}],{fast:true})).removed,[]);
    assert.ok(draft.evidence[0].quote.includes(finding));
    assert.deepEqual(verifyEvidence(draft.evidence,draft.footnotes,sourcesTextMap([{url,content}])),[]);
  }finally{nim.nimChatLong=original;}
});

test('a temporary audit outage preserves completed checks for the next attempt',async()=>{
  const url='https://example.org/resumable-audit';
  const facts=['The greenhouse experiment recorded rice water consumption during the drought observation period.','The greenhouse experiment recorded plant height during the same drought observation period.'];
  const sources=[{url,content:facts.join(' '),title:'Resumable experiment',author:'',publisher:'',year:'',accessed:''}];
  const originalDraft={title:'Resuming',introduction:[`${facts[0]}[^1]`],sections:[{heading:'Height',paragraphs:[`${facts[1]}[^1]`]}],conclusion:[],footnotes:[{id:1,url}],evidence:[],worksCited:[],coverage:[]};
  const original=nim.nimChatLong; const calls=[0,0];
  nim.nimChatLong=async request=>{
    const batch=JSON.parse(request.user.split('ESSAY PARAGRAPHS AND SENTENCES:\n')[1].split('\n\nReturn')[0]);
    const paragraph=batch[0].paragraph;calls[paragraph]++;
    if(paragraph===1&&calls[1]===1){const error=new Error('Internal server error');error.status=500;throw error;}
    return JSON.stringify({claims:[{paragraph,sentenceIndex:0,status:'supported',supportingSourceIndex:0,supportingPassageIndexes:[0],reason:'Direct experiment statement.'}]});
  };
  try{
    await assert.rejects(auditAndAlignGrounding(structuredClone(originalDraft),sources,{batchSize:1,fast:true}),/Internal server error/);
    const draft=structuredClone(originalDraft);
    await auditAndAlignGrounding(draft,sources,{batchSize:1,fast:true});
    assert.deepEqual(calls,[1,2]);
    assert.deepEqual(verifyEvidence(draft.evidence,draft.footnotes,sourcesTextMap(sources)),[]);
  }finally{nim.nimChatLong=original;}
});

test('allowing uncited paragraph formatting cannot attach another paragraphs source to an uncited fact',async()=>{
  const url='https://example.org/no-decorative-citation';
  const content='The greenhouse experiment recorded water consumption during its drought observation period.';
  const sources=[{url,content,title:'Greenhouse experiment',author:'',publisher:'',year:'',accessed:''}];
  const draft={title:'Scope',introduction:[`${content}[^1]`],sections:[{heading:'Uncited',paragraphs:[content]}],conclusion:[],footnotes:[{id:1,url}],evidence:[],worksCited:[],coverage:[]};
  const original=nim.nimChatLong;
  nim.nimChatLong=async request=>{
    const batch=JSON.parse(request.user.split('ESSAY PARAGRAPHS AND SENTENCES:\n')[1].split('\n\nReturn')[0]);
    assert.deepEqual(batch[1].citedSources[0].urls,[]);
    return JSON.stringify({claims:batch.map(paragraph=>({paragraph:paragraph.paragraph,sentenceIndex:0,status:'supported',supportingSourceIndex:0,supportingPassageIndexes:[0],reason:'The page contains this claim.'}))});
  };
  try{
    const audit=await auditAndAlignGrounding(draft,sources,{batchSize:4,fast:true});
    assert.equal(audit.removed.length,1);
    assert.equal(draft.sections[0].paragraphs[0],'');
    assert.equal(draft.evidence.length,1);
  }finally{nim.nimChatLong=original;}
});

test('basic knowledge and warranted reasoning survive uncited while research and measurements still need sources',async()=>{
  const url='https://example.org/knowledge-versus-findings';
  const content='The experiment recorded plant growth under dry conditions during the observation period.';
  const basic='Water availability helps plants grow.';
  const inference='This observation warrants caution about extending the finding beyond those conditions.';
  const research='Research shows that editing this gene improves crop performance.';
  const measurement='Editing this gene improves yield by 42 percent.';
  const sources=[{url,content,title:'Growth experiment',author:'',publisher:'',year:'',accessed:''}];
  const draft={title:'Knowledge',introduction:[`${content}[^1]`],sections:[{heading:'Evaluation',paragraphs:[`${basic} ${inference} ${research} ${measurement}`]}],conclusion:[],footnotes:[{id:1,url}],evidence:[],worksCited:[],coverage:[]};
  const original=nim.nimChatLong;
  nim.nimChatLong=async request=>{
    assert.match(request.system,/Basic, widely established knowledge and warranted reasoning do not require citations/);
    return JSON.stringify({claims:[
      {paragraph:0,sentenceIndex:0,status:'supported',supportingSourceIndex:0,supportingPassageIndexes:[0],reason:'Direct finding.'},
      {paragraph:1,sentenceIndex:0,status:'common_knowledge',reason:'Basic background.'},
      {paragraph:1,sentenceIndex:1,status:'logical_inference',reason:'Qualified interpretation of the established finding.'},
      {paragraph:1,sentenceIndex:2,status:'common_knowledge',reason:'Incorrect research exemption.'},
      {paragraph:1,sentenceIndex:3,status:'common_knowledge',reason:'Incorrect measurement exemption.'}
    ]});
  };
  try{
    const audit=await auditAndAlignGrounding(draft,sources,{batchSize:4,fast:true});
    assert.equal(audit.removed.length,2);
    assert.equal(draft.sections[0].paragraphs[0],`${basic} ${inference}`);
    assert.equal(draft.evidence.length,1);
  }finally{nim.nimChatLong=original;}
});

test('negative no-source sentinel on nonfactual audit claims does not rewrite the essay',async()=>{
  const url='https://example.org/no-source-sentinel';
  const content='The trial recorded reduced water use in experimental plants under dry conditions.';
  const sources=[{url,content,title:'Trial',author:'',publisher:'',year:'',accessed:''}];
  const draft={title:'Trial',introduction:[`${content}[^1]`],sections:[{heading:'Assessment',paragraphs:['This observation warrants careful interpretation.']}],conclusion:[],footnotes:[{id:1,url}],evidence:[],worksCited:[],coverage:[]};
  const original=nim.nimChatLong;
  let calls=0;
  nim.nimChatLong=async()=>{calls++;return JSON.stringify({claims:[
    {paragraph:0,sentenceIndex:0,status:'supported',supportingSourceIndex:0,supportingPassageIndexes:[0],reason:'Direct statement.'},
    {paragraph:1,sentenceIndex:0,status:'logical_inference',supportingSourceIndex:-1,supportingPassageIndexes:[],reason:'Careful interpretation.'}
  ]});};
  try{
    const audit=await auditAndAlignGrounding(draft,sources,{batchSize:4,fast:true});
    assert.equal(calls,1);
    assert.deepEqual(audit.removed,[]);
    assert.equal(draft.sections[0].paragraphs[0],'This observation warrants careful interpretation.');
  }finally{nim.nimChatLong=original;}
});

test('a correctly quoted source about a different subject cannot enter the essay',async()=>{
  const url='https://example.org/mixed-subjects';
  const topicFact='The study describes targeted edits in crop plants under dry field conditions.';
  const otherFact='The same report describes altered growth rates in farm animals under controlled conditions.';
  const sources=[{url,content:`${topicFact} ${otherFact}`,title:'Mixed report',author:'',publisher:'',year:'',accessed:''}];
  const draft={title:'Crop essay',introduction:[`${topicFact}[^1]`],sections:[{heading:'Crop outcomes',paragraphs:[`${otherFact}[^1]`]}],conclusion:[],footnotes:[{id:1,url}],evidence:[],worksCited:[],coverage:[]};
  const original=nim.nimChatLong;
  nim.nimChatLong=async request=>{
    assert.match(request.user,/ESSAY TOPIC:\nCrop improvement/);
    const batch=JSON.parse(request.user.split('ESSAY PARAGRAPHS AND SENTENCES:\n')[1].split('\n\nReturn')[0]);
    assert.equal(batch[1].heading,'Crop outcomes');
    return JSON.stringify({claims:batch.map(item=>({paragraph:item.paragraph,sentenceIndex:0,status:'supported',onTopic:item.paragraph===0,supportingSourceIndex:0,supportingPassageIndexes:[0],reason:'Exact page text but different subject.'}))});
  };
  try{
    const result=await auditAndAlignGrounding(draft,sources,{topic:'Crop improvement',fast:true});
    assert.equal(result.removed.length,1);
    assert.equal(draft.sections[0].paragraphs[0],'');
    assert.equal(draft.evidence.length,1);
  }finally{nim.nimChatLong=original;}
});

test('named examples absent from the cited page are removed even when the model claims support', async () => {
  const url = 'https://example.edu/crop-trials';
  const content = 'University researchers study crop disease resistance and plant nutrition in field trials across several growing seasons.';
  const fabricated = 'Powdery-mildew-resistant wheat and low-phytate soybeans demonstrate successful biofortification.';
  const genuine = 'University researchers study crop disease resistance in field trials.';
  const sources = [{ url, content, title: 'Crop research', author: '', publisher: '', year: '', accessed: '' }];
  const draft = { title: 'Crops', introduction: [], sections: [{ heading: 'Results', paragraphs: [`${fabricated}[^1] ${genuine}[^1]`] }], conclusion: [], footnotes: [{ id: 1, url }], evidence: [], worksCited: [], coverage: [] };
  const original = nim.nimChatLong;
  nim.nimChatLong = async () => JSON.stringify({ claims: [
    { paragraph: 0, sentenceIndex: 0, status: 'supported', supportingSourceIndex: 0, supportingPassageIndexes: [0], reason: 'Incorrect verdict from the auditor.' },
    { paragraph: 0, sentenceIndex: 1, status: 'supported', supportingSourceIndex: 0, supportingPassageIndexes: [0], reason: 'Direct finding.' },
  ] });
  try {
    const audit = await auditAndAlignGrounding(draft, sources);
    assert.equal(audit.removed.length, 1);
    assert.match(audit.removed[0], /never mentions/);
    assert.ok(!draft.sections[0].paragraphs[0].includes('soybeans'));
    assert.ok(draft.sections[0].paragraphs[0].includes(genuine));
    assert.equal(draft.footnotes.length, 1);
    assert.deepEqual(verifyEvidence(draft.evidence, draft.footnotes, sourcesTextMap(sources)), []);
  } finally { nim.nimChatLong = original; }
});

test('review-level claims naming absent examples are removed', async () => {
  const url = 'https://example.org/breeding-review';
  const content = 'This review summarizes breeding programs and regulatory frameworks for improved crops in developing regions.';
  const fabricated = 'Golden rice or high-iron beans could address hidden hunger.';
  const genuine = 'This review summarizes breeding programs for improved crops.';
  const sources = [{ url, content, title: 'Breeding review', author: '', publisher: '', year: '', accessed: '' }];
  const draft = { title: 'Crops', introduction: [], sections: [{ heading: 'Nutrition', paragraphs: [`${fabricated}[^1] ${genuine}[^1]`] }], conclusion: [], footnotes: [{ id: 1, url }], evidence: [], worksCited: [], coverage: [] };
  const original = nim.nimChatLong;
  nim.nimChatLong = async () => JSON.stringify({ claims: [
    { paragraph: 0, sentenceIndex: 0, status: 'supported', supportingSourceIndex: 0, supportingPassageIndexes: [0], reason: 'Incorrect verdict from the auditor.' },
    { paragraph: 0, sentenceIndex: 1, status: 'supported', supportingSourceIndex: 0, supportingPassageIndexes: [0], reason: 'Direct summary.' },
  ] });
  try {
    const audit = await auditAndAlignGrounding(draft, sources);
    assert.equal(audit.removed.length, 1);
    assert.ok(!draft.sections[0].paragraphs[0].includes('Golden rice'));
    assert.ok(draft.sections[0].paragraphs[0].includes(genuine));
    assert.equal(draft.footnotes.length, 1);
  } finally { nim.nimChatLong = original; }
});

test('faithful paraphrases sharing the passage subject matter stay supported', async () => {
  const url = 'https://example.org/drought-trial';
  const content = 'Gene editing increased rice yields by 19 percent during the drought trial observations.';
  const sentence = 'Editing this gene improves rice yield by 19 percent in drought trials.';
  const sources = [{ url, content, title: 'Drought trial', author: '', publisher: '', year: '', accessed: '' }];
  const draft = { title: 'Rice', introduction: [], sections: [{ heading: 'Drought', paragraphs: [`${sentence}[^1]`] }], conclusion: [], footnotes: [{ id: 1, url }], evidence: [], worksCited: [], coverage: [] };
  const original = nim.nimChatLong;
  nim.nimChatLong = async () => JSON.stringify({ claims: [
    { paragraph: 0, sentenceIndex: 0, status: 'supported', supportingSourceIndex: 0, supportingPassageIndexes: [0], reason: 'Paraphrased finding.' },
  ] });
  try {
    const audit = await auditAndAlignGrounding(draft, sources);
    assert.deepEqual(audit.removed, []);
    assert.ok(draft.sections[0].paragraphs[0].includes(sentence));
    assert.equal(draft.footnotes.length, 1);
    assert.deepEqual(verifyEvidence(draft.evidence, draft.footnotes, sourcesTextMap(sources)), []);
  } finally { nim.nimChatLong = original; }
});

test('specific risk assertions cannot pass as unevidenced analysis', async () => {
  const url = 'https://example.org/field-trial';
  const content = 'The field trial measured water use in edited plants under dry conditions.';
  const concern = 'The technology may disrupt local seed markets and harm smallholders.';
  const framing = 'We must weigh benefits against risks.';
  const sources = [{ url, content, title: 'Field trial', author: '', publisher: '', year: '', accessed: '' }];
  const draft = { title: 'Assessment', introduction: [`${content}[^1]`], sections: [{ heading: 'Society', paragraphs: [`${concern} ${framing}`] }], conclusion: [], footnotes: [{ id: 1, url }], evidence: [], worksCited: [], coverage: [] };
  const original = nim.nimChatLong;
  nim.nimChatLong = async () => JSON.stringify({ claims: [
    { paragraph: 0, sentenceIndex: 0, status: 'supported', supportingSourceIndex: 0, supportingPassageIndexes: [0], reason: 'Direct measurement.' },
    { paragraph: 1, sentenceIndex: 0, status: 'logical_inference', reason: 'Incorrectly exempted concern.' },
    { paragraph: 1, sentenceIndex: 1, status: 'nonfactual', reason: 'Evaluative framing.' },
  ] });
  try {
    const audit = await auditAndAlignGrounding(draft, sources);
    assert.equal(audit.removed.length, 1);
    assert.equal(draft.sections[0].paragraphs[0], framing);
  } finally { nim.nimChatLong = original; }
});

test('lexical entailment gate ignores generic claims but catches missing subjects', () => {
  assert.deepEqual(uncoveredClaimTerms('Plants need water.', 'Anything about irrigation and soil.'), []);
  const missing = uncoveredClaimTerms('Powdery-mildew-resistant wheat tolerates drought.', 'The trial studied barley growth under dry conditions.');
  assert.ok(missing.includes('wheat'));
  assert.deepEqual(uncoveredClaimTerms('Gene editing increased rice yields by 19 percent during the drought trial.', 'Gene editing increased rice yields by 19 percent during the drought trial.'), []);
  assert.ok(uncoveredClaimTerms('Editing improves yield by 42 percent.', 'Editing improves yield by 19 percent.').includes('42'));
});
