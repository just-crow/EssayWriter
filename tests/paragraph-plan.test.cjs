const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planParagraphs, structuralSectionRole, sourceFindingSentences, sourceQualityFactor } = require('../lib/paragraph-plan.ts');

test('research questions are not treated as findings and listing pages rank below original sources', () => {
  assert.deepEqual(sourceFindingSentences('What limitations and costs accompany these strategies?'), []);
  const government = sourceQualityFactor({ url: 'https://www.epa.gov/green-infrastructure/benefits', kind: 'primary' });
  const listing = sourceQualityFactor({ url: 'https://vendor.example/category/green-infrastructure', kind: 'web' });
  assert.ok(government > listing);
});

test('named introduction and conclusion are briefs, never sourced body sections',()=>{
  const plan=planParagraphs({topic:'Crop editing and food security',wordTarget:1200,minimumSources:2,structureJson:JSON.stringify({thesis:'Evaluate crop editing.',sections:[
    {heading:'Introduction to Crop Editing',paragraphs:[{point:'Set out the research question.'}]},
    {heading:'Mechanisms and Applications',paragraphs:[{point:'Explain observed crop traits.'}]},
    {heading:'Environmental and Social Impacts',paragraphs:[{point:'Evaluate reported benefits and risks.'}]},
    {heading:'Conclusion: Weighing the Impacts',paragraphs:[{point:'Synthesize the established findings without adding facts.'}]}
  ]})},[
    {id:'1',title:'Crop research',content:'Crop editing can modify plant genes and affect observed traits in rice experiments.'},
    {id:'2',title:'Impact research',content:'Studies of crop editing evaluate environmental risks and social access to modified crops.'}
  ]);
  assert.deepEqual(plan.headings,['Mechanisms and Applications','Environmental and Social Impacts']);
  assert.ok(plan.tasks.every(task=>task.section<2));
  assert.match(plan.tasks[0].point,/research question/);
  assert.match(plan.conclusionBrief,/Synthesize the established findings/);
  assert.equal(structuralSectionRole('2. Conclusion: Weighing the Impacts'),'conclusion');
  assert.equal(structuralSectionRole('Opening New Markets'),null);
  assert.equal(structuralSectionRole('Introductory Algebra'),null);
});

test('conference session summaries are not treated as scientific findings',()=>{
  assert.deepEqual(sourceFindingSentences('The session highlights climate-driven impacts on plant growth and health.'),[]);
});

test('a 1200-word essay develops each of three major questions in two paragraphs',()=>{
  const sections=['Scientific mechanisms','Social consequences','Ethical implications'].map(heading=>({heading,paragraphs:[{point:`Evaluate ${heading.toLowerCase()} using the available evidence.`}]}));
  const plan=planParagraphs({topic:'Genome editing and society',wordTarget:1200,structureJson:JSON.stringify({sections})},[
    {id:'1',title:'Research',content:'Genome editing changes specific traits, and research assesses consequences for society and ethical governance.'}
  ]);
  assert.deepEqual(sections.map((_,i)=>plan.tasks.filter(task=>task.section===i).length),[2,2,2]);
});

test('a final whole-essay judgment belongs in the conclusion rather than a second summary body paragraph',()=>{
  const sections=[
    {heading:'Benefits',paragraphs:[{point:'Assess reported benefits.'}]},
    {heading:'Costs',paragraphs:[{point:'Assess reported costs.'}]},
    {heading:'Governance',paragraphs:[{point:'Assess safety oversight.'},{point:'Make a reasoned judgment that weighs the established benefits against the costs.'}]}
  ];
  const plan=planParagraphs({topic:'Technology and society',wordTarget:1200,structureJson:JSON.stringify({sections})},[
    {id:'1',title:'Assessment',content:'Technology can provide reported benefits, but researchers also examine costs and safety oversight before adoption.'}
  ]);
  assert.match(plan.conclusionBrief,/reasoned judgment/);
  assert.ok(plan.tasks.filter(task=>task.section>=0).every(task=>!task.point.includes('reasoned judgment')));
  assert.deepEqual(sections.map((_,i)=>plan.tasks.filter(task=>task.section===i).length),[2,2,1]);
});
const { evidenceSpine } = require('../lib/evidence-spine.ts');

test('outline purposes and criteria govern evidence placement instead of generic topic overlap', () => {
  const plan = planParagraphs({ topic: 'Genome editing', wordTarget: 600, minimumSources: 3,
    structureJson: JSON.stringify({ thesis: 'Evaluate the benefits and limits of adoption.', sections: [
      { heading: 'Economic effects', paragraphs: [{ point: 'Assess seed licensing costs and access for farmers.', criterion: 'D', strand: 'ii' }, { point: 'Evaluate how affordability limits adoption.', criterion: 'D', strand: 'ii' }] },
      { heading: 'Environmental risks', paragraphs: [{ point: 'Evaluate risks for non-target organisms and environmental monitoring.', criterion: 'D', strand: 'ii' }] },
    ] }),
  }, [
    { id: '1', title: 'Overview', content: 'Genome editing modifies genetic material through targeted changes and offers opportunities for improving crop characteristics.' },
    { id: '2', title: 'Costs', content: 'Seed licensing costs can limit access for farmers, and affordability remains a constraint on adoption.' },
    { id: '3', title: 'Safety', content: 'Environmental monitoring evaluates risks for non-target organisms after release and can identify unexpected ecological effects.' },
  ]);
  const economic = plan.tasks.find(t => t.section === 0);
  const risk = plan.tasks.find(t => t.section === 1);
  assert.match(economic.point, /affordability/);
  assert.equal(economic.criterion, 'D');
  assert.equal(economic.strand, 'ii');
  assert.equal(economic.finding.sourceId, 2);
  assert.equal(risk.finding.sourceId, 3);
  assert.equal(plan.thesis, 'Evaluate the benefits and limits of adoption.');
});

test('section evidence survives selection when it appears after a generic abstract', () => {
  const content = 'The report provides a general overview of genome editing and plant improvement. Genome editing has many applications for agricultural research and crop development. Licensing costs limit access for small farmers and require an assessment of affordability.';
  const sources = [{ id: '1', url: 'https://example.org/report', title: 'Report', content }];
  const facts = JSON.parse(evidenceSpine(sources, sources, 1, 1, '{"sections":[{"heading":"Economic impacts","paragraphs":[{"point":"Evaluate licensing costs and affordability for farmers."}]}]}'));
  assert.match(facts[0].text, /Licensing costs/);
  assert.ok(content.includes(facts[0].text));
});

test('an unused unrelated finding cannot displace relevant evidence in a later evaluation', () => {
  const plan = planParagraphs({ topic: 'Genome editing in plants', wordTarget: 600, structureJson: JSON.stringify({ sections: [{
    heading: 'Environmental risks', paragraphs: [
      { point: 'Discuss gene flow risks for wild plants and non-target organisms.' },
      { point: 'Weigh gene flow risks against the need for environmental monitoring.' },
    ],
  }] }) }, [
    { id: '1', title: 'Safety', content: 'Gene flow to wild plants and effects on non-target organisms are environmental risks evaluated through monitoring.' },
    { id: '2', title: 'Microbes', content: 'Genome editing in plants can include microbial partners involved in nutrient uptake and improved crop growth.' },
  ]);
  assert.deepEqual(plan.tasks.filter(t => t.role === 'body').map(t => t.finding.sourceId), [1, 1]);
});

test('a section judgment evaluates its established evidence rather than introducing an unrelated unused work', () => {
  const plan = planParagraphs({ topic: 'Plant editing', wordTarget: 600, structureJson: JSON.stringify({ sections: [{
    heading: 'Responsible adoption', paragraphs: [
      { point: 'Discuss regulatory safety assessment before adoption.' },
      { point: 'Make a reasoned judgment about innovation versus precaution.' },
    ],
  }] }) }, [
    { id: '1', title: 'Regulation', content: 'Regulatory safety assessment examines environmental risks before approval of edited plants for cultivation.' },
    { id: '2', title: 'Innovation', content: 'Innovation in microbial nutrient uptake can contribute to plant growth in laboratory experiments.' },
  ]);
  const [first, judgment] = plan.tasks.filter(t => t.section === 0);
  assert.equal(first.finding.sourceId, 1);
  assert.equal(judgment.role, 'judgment');
  assert.deepEqual(judgment.assigned, [first.finding]);
});

test('planned prose receives complementary findings from separate relevant pages when one excerpt is thin', () => {
  const plan = planParagraphs({ topic: 'Urban tree stormwater management', wordTarget: 800,
    maxAssignedFindings: 3, structureJson: JSON.stringify({sections:[{
      heading:'Stormwater management benefits',paragraphs:[{point:'Assess runoff reduction and infiltration.'}],
    }]}) }, [
    {id:'1',title:'Runoff study',url:'https://agency.gov/runoff',kind:'primary',content:'Urban trees intercept rainfall before it reaches streets, reducing stormwater runoff during storms.'},
    {id:'2',title:'Infiltration study',url:'https://university.edu/infiltration',kind:'academic',content:'Tree roots improve water infiltration in planted soil, reducing runoff into conventional drainage systems.'},
  ]);
  const body = plan.tasks.find(task => task.role === 'body');
  assert.ok(body.assigned.length >= 2);
  assert.equal(new Set(body.assigned.map(finding => finding.sourceId)).size, 2);
});

test('an 800-word comparison reserves two developed paragraphs for each major question', () => {
  const plan = planParagraphs({topic:'Urban trees and city planning',wordTarget:800,
    structureJson:JSON.stringify({sections:[
      {heading:'Environmental benefits',paragraphs:[{point:'Assess rainwater interception.'}]},
      {heading:'Planning limits',paragraphs:[{point:'Assess maintenance funding.'}]},
    ]})},[
    {id:'1',title:'Tree research',content:'Urban trees intercept rainwater during storms and reduce runoff across city streets.'},
    {id:'2',title:'Planning research',content:'Long-term maintenance funding limits planting programmes because dead urban trees require replacement.'},
  ]);
  assert.deepEqual([0,1].map(section=>plan.tasks.filter(task=>task.section===section).length),[2,2]);
});
