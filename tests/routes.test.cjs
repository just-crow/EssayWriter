const { test } = require("node:test");
const assert = require("node:assert/strict");
const nim = require("../lib/nim.ts");
const search = require("../lib/search.ts");
const { prisma } = require("../lib/db.ts");
const draftRoute = require("../app/api/draft/route.ts");
const refineRoute = require("../app/api/refine/route.ts");
const downloadRoute = require("../app/api/download/[id]/route.ts");
const url = "https://example.org/source";
const content = "An introductory statement. A supported claim. A concluding statement.";
const modelDraft = {
  title: 'Test essay “Water” – Ż', introduction: ["An introductory statement."],
  sections: [{ heading: "Claim", paragraphs: ["A supported claim."] }],
  conclusion: ["A concluding statement."], footnotes: [{ id: 3, title: "Source", url }],
  evidence: [0, 1, 2].map((paragraph) => ({ paragraph, source: 3, quote: content })),
};
const post = (body) => new Request("http://localhost/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("draft and repeated revisions preserve citations, source texts, project and version numbering", async () => {
  const originalChat = nim.nimChatLong;
  const originalSearch = search.liveSearch;
  const prompts = [];
  nim.nimChatLong = async (p) => {
    prompts.push(p);
    return JSON.stringify(p.system.includes("source-grounding auditor") ? {
      claims: [
        { paragraph: 0, sentence: "An introductory statement.", status: "supported", supportingUrl: url, supportingQuote: "An introductory statement.", reason: "Test source." },
        { paragraph: 1, sentence: "A supported claim.", status: "supported", supportingUrl: url, supportingQuote: "An introductory statement. A supported claim.", reason: "Test source." },
        { paragraph: 2, sentence: "A concluding statement.", status: "supported", supportingUrl: url, supportingQuote: "A concluding statement.", reason: "Test source." },
      ],
    } : modelDraft);
  };
  search.liveSearch = async () => [];
  try {
    const invalid = await draftRoute.POST(post({ topic: "Topic", wordTarget: 200, structureJson: "{}", sourcesJson: "not json" }));
    assert.equal(invalid.status, 400);
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
    const other = await prisma.project.create({ data: { topic: "Other" } });
    const mismatch = await refineRoute.POST(post({ projectId: other.id, versionId: first.versionId, instruction: "Revise" }));
    assert.equal(mismatch.status, 400);
  } finally {
    nim.nimChatLong = originalChat;
    search.liveSearch = originalSearch;
  }
});
