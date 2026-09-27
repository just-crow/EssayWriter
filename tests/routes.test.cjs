const { test } = require("node:test");
const assert = require("node:assert/strict");
const nim = require("../lib/nim.ts");
const writer = require("../lib/source-writer.ts");
const search = require("../lib/search.ts");
const { prisma } = require("../lib/db.ts");
const draftRoute = require("../app/api/draft/route.ts");
const refineRoute = require("../app/api/refine/route.ts");
const downloadRoute = require("../app/api/download/[id]/route.ts");
const url = "https://example.org/source";
const content = "An introductory statement. A supported claim. A concluding statement.";
const modelDraft = {
  title: 'Test essay “Water” – Ż', introduction: ["An introductory statement.[^1]"],
  sections: [{ heading: "Claim", paragraphs: ["A supported claim.[^1]"] }],
  conclusion: ["A concluding statement.[^1]"], footnotes: [{ id: 1, title: "Source", url }],
  evidence: [0, 1, 2].map((paragraph) => ({ paragraph, source: 1, quote: content })),
};
const post = (body) => new Request("http://localhost/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("draft and repeated revisions preserve citations, source texts, project and version numbering", async () => {
  const originalChat = nim.nimChatLong;
  const originalWriter = writer.composeSourceDraft;
  writer.composeSourceDraft = async () => structuredClone(modelDraft);
  const originalSearch = search.liveSearch;
  const prompts = [];
  nim.nimChatLong = async (p) => {
    prompts.push(p);
    return JSON.stringify(p.system.includes("select evidence before") ? { selections: [{ sourceIndex: 0, passageIndexes: [0] }] } : p.system.includes("source-grounding auditor") ? {
      claims: [
        { paragraph: 0, sentence: "An introductory statement.", sentenceIndex: 0, status: "supported", supportingSourceIndex: 0, supportingPassageIndexes: [0], reason: "Test source." },
        { paragraph: 1, sentence: "A supported claim.", sentenceIndex: 0, status: "supported", supportingSourceIndex: 0, supportingPassageIndexes: [0], reason: "Test source." },
        { paragraph: 2, sentence: "A concluding statement.", sentenceIndex: 0, status: "supported", supportingSourceIndex: 0, supportingPassageIndexes: [0], reason: "Test source." },
      ],
    } : modelDraft);
  };
  let searchCalls = 0;
  search.liveSearch = async () => { searchCalls++; return []; };
  try {
    const invalid = await draftRoute.POST(post({ topic: "Topic", wordTarget: 200, structureJson: "{}", sourcesJson: "not json" }));
    assert.equal(invalid.status, 400);
    assert.equal(prompts.length, 0);
    const invalidOutline = await draftRoute.POST(post({ topic: "Topic", wordTarget: 200, structureJson: "not json", sourcesJson: "[]" }));
    assert.equal(invalidOutline.status, 400);
    assert.equal(prompts.length, 0);
    const firstResponse = await draftRoute.POST(post({ topic: "Topic", wordTarget: 200, structureJson: "{}", sourcesJson: JSON.stringify([{ url, title: "Source", content }]) }));
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 200, first.error);
    assert.equal(first.version, 1);
    assert.equal(first.footnoteCount, 3);
    const download = await downloadRoute.GET(new Request("http://localhost/api/download"), { params: Promise.resolve({ id: first.versionId }) });
    assert.equal(download.status, 200);
    assert.match(download.headers.get("Content-Disposition"), /filename\*=UTF-8''/);
    assert.ok((await download.arrayBuffer()).byteLength > 0);
    const saved = await prisma.source.findMany({ where: { projectId: first.projectId } });
    assert.equal(saved[0].content, content);
    for (const expected of [2, 3]) {
      const response = await refineRoute.POST(post({ projectId: first.projectId, versionId: first.versionId, instruction: "Improve analysis." }));
      const revised = await response.json();
      assert.equal(response.status, 200, revised.error);
      assert.equal(revised.projectId, first.projectId);
      assert.equal(revised.version, expected);
      assert.equal(revised.draft.evidence[0].source, 1);
    }
    const callsBefore = searchCalls;
    const wordingOnly = await refineRoute.POST(post({ projectId: first.projectId, versionId: first.versionId, instruction: "Improve wording. Do not introduce any new sources." }));
    assert.equal(wordingOnly.status, 200);
    assert.equal(searchCalls, callsBefore, 'An explicit no-new-sources instruction skips source gathering.');
    const other = await prisma.project.create({ data: { topic: "Other" } });
    const mismatch = await refineRoute.POST(post({ projectId: other.id, versionId: first.versionId, instruction: "Revise" }));
    assert.equal(mismatch.status, 400);
  } finally {
    nim.nimChatLong = originalChat;
    writer.composeSourceDraft = originalWriter;
    search.liveSearch = originalSearch;
  }
});
