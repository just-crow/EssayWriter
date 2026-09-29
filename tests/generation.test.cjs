const { test } = require("node:test");
const assert = require("node:assert/strict");
const { z } = require("zod");
const { parseModelJson, completeJson, nimChatLong, nimClient } = require("../lib/nim.ts");
const { DraftSchema, writerDraftSchema } = require("../lib/essay-types.ts");
const { prepareDraft, verifyEvidence, sourcesTextMap, expandFootnoteUses, repairEvidenceQuotes, splitSentences, validateDraft } = require("../lib/validate.ts");
const { buildDocx } = require("../lib/docx-build.ts");
const JSZip = require("jszip");

test("essay word count excludes headings and citation markers", () => {
  const { countWords } = require('../lib/docx-build.ts');
  assert.equal(countWords(draft({ introduction: ['One two.[^1]'], sections: [{ heading: 'A long heading excluded from the count', paragraphs: ['Three [^2] four.'] }], conclusion: ['Five.'] })), 5);
});

test("repeated wording can be detected without rejecting the essay", () => {
  const { repeatedSentences } = require("../lib/validate.ts");
  const sentence = "The course introduces mathematical proofs through logic, sets, functions, induction, and combinatorics for incoming computing students.";
  assert.equal(repeatedSentences([sentence + "[^1]", sentence + "[^2]", sentence + "[^3]"]).length, 2);
});

test("a short audited paragraph is reported for review rather than discarded", () => {
  const issues = validateDraft(draft({ sections: [{ heading: 'Argument', paragraphs: ['One supported point remains.[^7] It still belongs in this section.'] }] }));
  assert.ok(issues.some(issue => issue.code === 'SHORT_PARAGRAPH'));
});

const url = "https://example.org/source";
const text = "A verified passage about the topic with sufficient detail.";
const sources = sourcesTextMap([{ url, content: text }]);
function draft(overrides = {}) {
  return DraftSchema.parse({
    title: "Essay", introduction: ["Introduction."],
    sections: [{ heading: "Argument", paragraphs: ["Supported claim."] }],
    conclusion: ["Conclusion."],
    footnotes: [{ id: 7, title: "Source", url, accessed: "26 Sep 2026" }],
    evidence: [0, 1, 2].map((paragraph) => ({ paragraph, source: 7, quote: text })), ...overrides,
  });
}

test("JSON repairs preserve prose punctuation, braces, escapes and fences", () => {
  const prose = 'Literal comma, } and comma, ] plus "quotes" and \\ paths and ```json fences and <think>literal tags</think>.';
  assert.equal(parseModelJson(JSON.stringify({ prose })).prose, prose);
  assert.equal(parseModelJson('```json\n' + JSON.stringify({ prose }).replace(/}$/, ",}") + '\n``` trailing {comment}').prose, prose);
  assert.deepEqual(parseModelJson('<think>{ignore this}</think> {"items":[1,2,],"text":"line\nnext",}'), { items: [1, 2], text: "line\nnext" });
  assert.throws(() => parseModelJson('{"text":"unfinished'), /malformed/);
  assert.throws(() => parseModelJson('{"text":"unescaped "quotes""}'), /malformed/);
});

test("sentence splitting preserves decimal percentages and citation markers", () => {
  assert.deepEqual(splitSentences("A 76.5% share was observed.[^1] Next result."), [
    "A 76.5% share was observed.[^1]",
    "Next result.",
  ]);
  assert.deepEqual(splitSentences("In the U.S., 68.4% participated.[^2] Dr. Lee reported this."), [
    "In the U.S., 68.4% participated.[^2]",
    "Dr. Lee reported this.",
  ]);
});

test("missing markers are recovered only from verified paragraph evidence", () => {
  const d = draft();
  prepareDraft(d, sources);
  assert.equal(d.sections[0].paragraphs[0], "Supported claim.[^2]");
  assert.deepEqual(d.evidence.map((item) => item.source), [1, 2, 3]);
  assert.equal(d.worksCited.length, 1);
  assert.deepEqual(verifyEvidence(d.evidence, d.footnotes, sources), []);
  assert.throws(() => prepareDraft(draft({ evidence: [] }), sources), /no usable in-text citations/);
  assert.throws(() => prepareDraft(draft({ evidence: [
    { paragraph: 0, source: 7, quote: text },
    { paragraph: 1, source: 7, quote: "Invented evidence that does not exist" },
    { paragraph: 2, source: 7, quote: text },
  ] }), sources), /Unverifiable/);
  assert.throws(() => prepareDraft(draft({ evidence: [
    ...[0, 1, 2].map((paragraph) => ({ paragraph, source: 7, quote: text })),
    { paragraph: 99, source: 7, quote: text },
  ] }), sources), /does not exist/);
});

test("mixed citation formats, pruning and repeated footnotes keep evidence aligned", async () => {
  const d = draft({
    introduction: ["Background.[7]"],
    sections: [{ heading: "Argument", paragraphs: ["Claim.[^7] More.[7]", "Other.[7]"] }],
    footnotes: [{ id: 42, title: "Unused" }, { id: 7, title: "Source", url, accessed: "26 Sep 2026" }],
    evidence: [0, 1, 2, 3].map((paragraph) => ({ paragraph, source: 7, quote: text })),
  });
  prepareDraft(d, sources);
  assert.deepEqual(d.footnotes.map((f) => f.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(d.evidence.map((e) => e.source), [1, 2, 4, 5]);
  const snapshot = JSON.stringify(d);
  expandFootnoteUses(d);
  assert.equal(JSON.stringify(d), snapshot);
  const file = await buildDocx(d);
  const zip = await JSZip.loadAsync(file);
  const body = await zip.file("word/document.xml").async("string");
  const notes = await zip.file("word/footnotes.xml").async("string");
  assert.equal((body.match(/<w:footnoteReference /g) || []).length, 5);
  for (let id = 1; id <= 5; id++) assert.match(notes, new RegExp(`w:id="${id}"`));
  assert.equal(JSON.stringify(d), snapshot);
});

test("unknown citations and ambiguous footnote IDs cannot silently disappear", () => {
  assert.throws(() => prepareDraft(draft({ sections: [{ paragraphs: ["Unsupported.[^99]" ] }] }), sources), /has no footnote/);
  assert.throws(() => prepareDraft(draft({ footnotes: [{ id: 7 }, { id: 7 }] }), sources), /duplicate/);
});

test("source snapshots preserve old evidence when a page is fetched again", () => {
  const updated = "A newer passage from the updated page.";
  const map = sourcesTextMap([{ url, content: "" }, { url, content: text }, { url, content: updated }]);
  assert.deepEqual(verifyEvidence([{ source: 1, paragraph: 0, quote: text }, { source: 1, paragraph: 0, quote: updated }], [{ id: 1, url }], map), []);
});

test("close evidence paraphrases repair to exact text without accepting unrelated claims", () => {
  const exact = "Adolescence is a critical period marked by major biological cognitive and social changes.";
  const map = sourcesTextMap([{ url, content: exact }]);
  const evidence = [{ paragraph: 0, source: 1, quote: "Adolescence is a critical period with major biological, cognitive, and social changes." }];
  assert.equal(repairEvidenceQuotes(evidence, [{ id: 1, url }], map), 1);
  assert.equal(evidence[0].quote, exact);
  const invented = [{ paragraph: 0, source: 1, quote: "Teenagers need ten hours because their brains process algebra during dreams." }];
  assert.equal(repairEvidenceQuotes(invented, [{ id: 1, url }], map), 0);
  assert.match(verifyEvidence(invented, [{ id: 1, url }], map)[0], /not found/);
});

test("selective source usage: only cited sources are kept, unused sources are pruned without error", () => {
  const url1 = "https://example.org/source-1";
  const url2 = "https://example.org/source-2";
  const url3 = "https://example.org/source-3";
  const map = sourcesTextMap([
    { url: url1, content: "First verified passage with necessary detail." },
    { url: url2, content: "Second verified passage with necessary detail." },
    { url: url3, content: "Third verified passage with necessary detail." },
  ]);
  const d = DraftSchema.parse({
    title: "Selective Essay",
    introduction: ["Intro statement.[^1]"],
    sections: [{ heading: "Body", paragraphs: ["Second point.[^3]"] }],
    conclusion: ["Conclusion statement.[^1]"],
    footnotes: [
      { id: 1, title: "Source 1", url: url1, accessed: "26 Sep 2026" },
      { id: 2, title: "Source 2 (Unused)", url: url2, accessed: "26 Sep 2026" },
      { id: 3, title: "Source 3", url: url3, accessed: "26 Sep 2026" },
    ],
    evidence: [
      { paragraph: 0, source: 1, quote: "First verified passage with necessary detail." },
      { paragraph: 1, source: 3, quote: "Third verified passage with necessary detail." },
      { paragraph: 2, source: 1, quote: "First verified passage with necessary detail." },
    ],
  });
  prepareDraft(d, map);
  assert.equal(d.worksCited.length, 2);
  assert.ok(!d.worksCited.some((w) => w.includes("Source 2")));
  assert.deepEqual(verifyEvidence(d.evidence, d.footnotes, map), []);
});

test("cross-source repair and ellipsis-truncated quotes resolve to verbatim source sentences", () => {
  const urlA = "https://example.org/alpha";
  const urlB = "https://example.org/beta";
  const passageB = "Continuous monitoring through quizzes, drag-and-drop exercises, and symbolic manipulation supports learning.";
  const map = sourcesTextMap([
    { url: urlA, content: "Unrelated text about weather patterns and climate." },
    { url: urlB, content: passageB },
  ]);
  const evidence = [{ paragraph: 0, source: 1, quote: "continuous monitoring through quizzes, drag-and-drop exercises, and symbolic man..." }];
  const footnotes = [
    { id: 1, url: urlA, title: "Source A" },
    { id: 2, url: urlB, title: "Source B" },
  ];
  const count = repairEvidenceQuotes(evidence, footnotes, map, ["Monitoring students."]);
  assert.equal(count, 1);
  assert.equal(evidence[0].quote, passageB);
});

test("citation and JSON failures retry with actionable correction feedback", async () => {
  const requests = [];
  const responses = [JSON.stringify(draft({ evidence: [] })), '{"title":"broken', JSON.stringify(draft())];
  const result = await completeJson({ system: "Return JSON", user: "Write essay", schema: DraftSchema, parseTries: 3, validate: (d) => prepareDraft(d, sources) }, async (p) => {
    requests.push(p);
    return responses.shift();
  });
  assert.match(requests[1].user, /no usable in-text citations/);
  assert.match(requests[1].user, /PREVIOUS RESPONSE/);
  assert.ok(requests[1].user.includes('"title":"Essay"'));
  assert.match(requests[2].user, /malformed/);
  assert.equal(result.footnotes.length, 3);
  await assert.rejects(() => completeJson({ system: "JSON", user: "JSON", schema: z.object({ name: z.string() }) }, async () => '{"name":42}'), /invalid fields: name/);
});

test("writer schema permits ordinary prose formatting and requires structured fields", async () => {
  let request;
  const schema = writerDraftSchema();
  await completeJson({ system: "Write", user: "Write", schema }, async (params) => {
    request = params;
    return JSON.stringify(draft({ introduction: ["Opening.[^1]"], sections: [{ heading: "Body", paragraphs: ["Finding.[^1]"] }], conclusion: ["Conclusion."] }));
  });
  const format = request.responseFormat;
  assert.equal(format.type, "json_schema");
  const json = format.json_schema.schema;
  assert.equal(json.properties.introduction.items.type,"string");
  assert.equal(json.properties.introduction.items.pattern,undefined);
  const prose='The source describes "targeted editing".[^1]\nIts implications require careful evaluation.';
  const parsed=schema.parse(draft({introduction:[prose],sections:[{heading:'Analysis',paragraphs:['These competing considerations warrant a cautious judgment.']}],conclusion:['The judgment follows the established discussion.']}));
  assert.equal(parsed.introduction[0],prose);
  assert.equal(parsed.sections[0].paragraphs.length,1);
  assert.ok(json.required.includes("sections"));
  assert.equal(json.properties.sections.items.additionalProperties, false);
});

test("writer sentence arrays and single paragraphs normalize without losing citations", () => {
  const normalized = writerDraftSchema().parse({
    title:"Course", introduction:"Intro.[^1]", conclusion:[["Closing.","The argument is synthesized."]],
    sections:[{heading:"Evidence",paragraphs:[["A source finding.[^1]","Its interpretation follows."]]}],
    footnotes:{malformed:"model metadata is ignored in initial drafts"}, worksCited:42, evidence:"invented",
  });
  assert.deepEqual(normalized.introduction,["Intro.[^1]"]);
  assert.deepEqual(normalized.sections[0].paragraphs,["A source finding.[^1] Its interpretation follows."]);
  assert.deepEqual(normalized.conclusion,["Closing. The argument is synthesized."]);
  assert.deepEqual(normalized.footnotes,[]);
});

test("domain repairs start from verified prose rather than restoring removed claims", async () => {
  let attempt = 0;
  const result = await completeJson({
    system: "Source first", user: "Write", schema: z.object({ sentences: z.array(z.string()) }),
    repairResponse: JSON.stringify,
    validate: (value) => {
      value.sentences = value.sentences.filter((text) => text !== "invented claim");
      if (value.sentences.length < 2) throw new Error("Expand the verified explanation.");
    },
  }, async (request) => {
    if (++attempt === 1) return JSON.stringify({sentences:["verified finding","invented claim"]});
    const prior = request.user.split("PREVIOUS RESPONSE:\n")[1].split("\n\nReturn")[0];
    assert.deepEqual(JSON.parse(prior).sentences, ["verified finding"]);
    return JSON.stringify({sentences:["verified finding","source-based analysis"]});
  });
  assert.equal(result.sentences.length, 2);
});

test("exhausted service retries are not multiplied by JSON repair attempts", async () => {
  let calls = 0;
  await assert.rejects(() => completeJson({ system:"JSON", user:"JSON", schema:z.object({ok:z.boolean()}), parseTries:3 }, async () => {
    calls++;
    throw new Error("Service temporarily overloaded");
  }), /Model service error.*overloaded/);
  assert.equal(calls,1);
});

test("nested draft composition preserves a single service error", async () => {
  await assert.rejects(() => completeJson({ system: 'JSON', user: 'JSON', schema: z.object({ ok: z.boolean() }) }, () =>
    completeJson({ system: 'JSON', user: 'JSON', schema: z.object({ ok: z.boolean() }) }, async () => {
      throw new Error('Service temporarily overloaded');
    })
  ), error => {
    assert.equal(error.message, 'Model service error (Service temporarily overloaded). Try again in a bit.');
    return true;
  });
});

test("an audit service outage does not regenerate an already written essay", async () => {
  let generations = 0, audits = 0;
  await assert.rejects(() => completeJson({
    system: 'JSON', user: 'JSON', schema: z.object({ ok: z.boolean() }), parseTries: 3,
    validate: async () => {
      audits++;
      throw new Error('Model service error (Service temporarily overloaded). Try again in a bit.');
    },
  }, async () => { generations++; return '{"ok":true}'; }), /Model service error.*overloaded/);
  assert.equal(generations, 1);
  assert.equal(audits, 1);
});

test("overload retries use increasing delays and honor provider retry-after", async () => {
  const { withRetry } = require('../lib/nim.ts');
  const originalTimer = global.setTimeout;
  const delays = [], attempts = [];
  let calls = 0;
  global.setTimeout = (callback, delay) => { delays.push(delay); callback(); };
  try {
    const result = await withRetry(async () => {
      if (++calls < 4) throw new Error('Service temporarily overloaded');
      return 'recovered';
    }, 4, n => attempts.push(n));
    assert.equal(result, 'recovered');
    assert.deepEqual(attempts, [1, 2, 3, 4]);
    assert.deepEqual(delays, [2000, 4000, 8000]);
    calls = 0;
    await withRetry(async () => {
      if (++calls === 1) throw Object.assign(new Error('Busy'), { status: 429, headers: new Headers({ 'retry-after': '7' }) });
      return 'recovered';
    }, 2);
    assert.equal(delays.at(-1), 7000);
  } finally { global.setTimeout = originalTimer; }
});

test("streaming honors reasoning toggle, retry options and rejects truncated output", async () => {
  process.env.NVIDIA_NIM_API_KEY = "test-only";
  const client = nimClient();
  const original = client.chat.completions.create;
  const attempts = [];
  let body;
  try {
    client.chat.completions.create = async (p) => {
      body = p;
      return (async function* () {
        yield { choices: [{ delta: { content: '{"ok":true}' }, finish_reason: null }] };
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      })();
    };
    assert.equal(await nimChatLong({ system: "JSON", user: "JSON", thinking: false, tries: 1, onAttempt: (n) => attempts.push(n) }), '{"ok":true}');
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.reasoning_effort, "none");
    assert.deepEqual(attempts, [1]);
    await nimChatLong({ system: "JSON", user: "JSON", thinking: true, lowEffort: true, reasoningBudget: 4096, tries: 1 });
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true, low_effort: true, reasoning_budget: 4096 });
    assert.equal(body.reasoning_effort, undefined);
    client.chat.completions.create = async () => (async function* () {
      yield { choices: [{ delta: { content: '{"incomplete":' }, finish_reason: "length" }] };
    })();
    await assert.rejects(() => nimChatLong({ system: "JSON", user: "JSON", tries: 1 }), /output limit/);
  } finally {
    client.chat.completions.create = original;
  }
});
