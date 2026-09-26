const { test } = require("node:test");
const assert = require("node:assert/strict");
const { z } = require("zod");
const { parseModelJson, completeJson, nimChatLong, nimClient } = require("../lib/nim.ts");
const { DraftSchema } = require("../lib/essay-types.ts");
const { prepareDraft, verifyEvidence, sourcesTextMap, expandFootnoteUses, repairEvidenceQuotes, splitSentences } = require("../lib/validate.ts");
const { buildDocx } = require("../lib/docx-build.ts");
const JSZip = require("jszip");

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
    client.chat.completions.create = async () => (async function* () {
      yield { choices: [{ delta: { content: '{"incomplete":' }, finish_reason: "length" }] };
    })();
    await assert.rejects(() => nimChatLong({ system: "JSON", user: "JSON", tries: 1 }), /output limit/);
  } finally {
    client.chat.completions.create = original;
  }
});
