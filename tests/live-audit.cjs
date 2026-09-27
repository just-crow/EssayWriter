const { z } = require("zod");
require("@next/env").loadEnvConfig(process.cwd());
const { completeJson, nimChatLong } = require("../lib/nim.ts");
const { normalizeUrl } = require("../lib/search.ts");
const { splitSentences, verifyEvidence, sourcesTextMap } = require("../lib/validate.ts");
const { validateDraft, assertNoRepeatedSentences } = require("../lib/validate.ts");
const { prisma } = require("../lib/db.ts");

const baseUrl = process.argv[2] || "http://localhost:3001";
const wordTarget = Number(process.argv[3] || 1200);
const tolerance = Number(process.argv[4] || 400);
const reuseLatest = process.argv.includes("--latest");
const reuseSources = process.argv.includes("--reuse-sources");
const requestedProjectId = process.argv.find((arg) => arg.startsWith("--project="))?.slice(10);
let topic = "How does sleep duration affect adolescent learning and mental health?";
let instructionText = "Write an evidence-based academic essay for an MYP student. Explain effects on attention, memory, school performance, mood, anxiety, and depression. Distinguish correlation from causation and acknowledge limits in the evidence. Use only the collected sources and cite every non-common factual claim.";

async function post(path, body) {
  // Native HTTP avoids Node fetch's fixed five-minute response-header timeout
  // while testing a route with generation, source verification, and repair.
  const url = new URL(`${baseUrl}${path}`);
  const client = require(url.protocol === "https:" ? "node:https" : "node:http");
  const response = await new Promise((resolve, reject) => {
    const request = client.request(url, { method: "POST", headers: { "Content-Type": "application/json" } }, (result) => {
      let text = "";
      result.setEncoding("utf8");
      result.on("data", (chunk) => { text += chunk; });
      result.on("end", () => { try { resolve({ status: result.statusCode, data: JSON.parse(text) }); } catch (error) { reject(error); } });
      result.on("error", reject);
    });
    request.setTimeout(900000, () => request.destroy(new Error("Live route test timed out after 15 minutes.")));
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
  const data = response.data;
  if (response.status >= 400) throw new Error(`${path} failed (${response.status}): ${data.error || JSON.stringify(data)}`);
  return data;
}

const ClaimSchema = z.object({
  paragraph: z.number().int().min(0),
  sentenceIndex: z.number().int().min(0),
  status: z.enum(["supported", "partially_supported", "common_knowledge", "logical_inference", "nonfactual", "unsupported"]),
  supportingUrls: z.array(z.string()).default([]),
  reason: z.string(),
});
const AuditSchema = z.object({ claims: z.array(ClaimSchema) });

function bodyParagraphs(draft) {
  return [
    ...draft.introduction,
    ...draft.sections.flatMap((section) => section.paragraphs),
    ...draft.conclusion,
  ];
}

function markerUrls(sentence, footnotes) {
  const byId = new Map(footnotes.map((f) => [f.id, normalizeUrl(f.url || "")]));
  return [...sentence.matchAll(/\[\^(\d+)\]/g)].map((m) => byId.get(Number(m[1]))).filter(Boolean);
}

async function main() {
  let sourceResult;
  let draftResult;
  if (reuseLatest) {
    console.error("[1/4] Loading the latest completed live draft...");
    const projects = await prisma.project.findMany({ orderBy: { updatedAt: "desc" }, take: 20, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
    const project = projects.find((p) => p.versions?.length && (!requestedProjectId || p.id === requestedProjectId));
    if (!project) throw new Error("No completed draft is available to audit.");
    topic = project.topic;
    instructionText = project.instruction;
    const version = project.versions[0];
    const draft = JSON.parse(version.essayJson);
    sourceResult = { sources: await prisma.source.findMany({ where: { projectId: project.id } }) };
    draftResult = { projectId: project.id, versionId: version.id, draft, wordCount: version.wordCount, issues: validateDraft(draft), downloadUrl: `/api/download/${version.id}` };
    console.error(`[2/4] Loaded ${sourceResult.sources.length} saved source snapshots.`);
    console.error("[3/4] Reusing the saved production draft.");
  } else if (reuseSources) {
    console.error("[1/4] Loading the latest live source collection...");
    const projects = requestedProjectId
      ? [await prisma.project.findUnique({ where: { id: requestedProjectId } })].filter(Boolean)
      : await prisma.project.findMany({ orderBy: { updatedAt: "desc" }, take: 20 });
    let project;
    for (const candidate of projects) {
      const sources = await prisma.source.findMany({ where: { projectId: candidate.id } });
      if (sources.length > 0) { project = { ...candidate, sources }; break; }
    }
    if (!project) throw new Error("No saved source collection is available.");
    sourceResult = { sources: project.sources };
    let structure = {
      thesis: "Adequate and regular sleep supports adolescent learning and mental health, while the largely associational evidence requires careful causal claims.",
      sections: [
        { heading: "Adolescent sleep needs", paragraphs: [{ point: "recommended duration and sleep patterns", criterion: "", strand: "" }] },
        { heading: "Attention and memory", paragraphs: [{ point: "attention, learning, and memory consolidation", criterion: "", strand: "" }] },
        { heading: "School performance", paragraphs: [{ point: "academic outcomes and competing explanations", criterion: "", strand: "" }] },
        { heading: "Mood and mental health", paragraphs: [{ point: "mood, anxiety, and depression", criterion: "", strand: "" }] },
        { heading: "Limits of the evidence", paragraphs: [{ point: "correlation, causation, measurement, and confounding", criterion: "", strand: "" }] },
      ], checklist: [],
    };
    if (requestedProjectId) {
      topic = project.topic;
      instructionText = project.instruction;
      console.error(`[1/4] Generating an outline for the selected project: ${topic}`);
      structure = (await post("/api/structure", { topic, instructionText, extraInstructions: "Use source-supported facts only. Clearly label proposed platform features as recommendations, not findings about existing platforms.", wordTarget })).structure;
    }
    console.error(`[2/4] Reusing ${sourceResult.sources.length} saved source snapshots.`);
    console.error("[3/4] Drafting with a five-section audit outline...");
    draftResult = await post("/api/draft", { topic, instructionText, extraInstructions: "", wordTarget, structureJson: JSON.stringify(structure), sourcesJson: JSON.stringify(sourceResult.sources), projectId: project.id });
  } else {
    console.error("[1/4] Generating outline...");
    const structureResult = await post("/api/structure", { topic, instructionText, extraInstructions: "", wordTarget });
    console.error(`[2/4] Gathering sources for ${structureResult.structure.sections.length} outline sections...`);
    sourceResult = await post("/api/sources", { topic, structureJson: JSON.stringify(structureResult.structure), projectId: structureResult.projectId, needed: 12 });
    console.error(`[3/4] Drafting from ${sourceResult.sources.length} collected sources...`);
    draftResult = await post("/api/draft", { topic, instructionText, extraInstructions: "", wordTarget, structureJson: JSON.stringify(structureResult.structure), sourcesJson: JSON.stringify(sourceResult.sources), projectId: structureResult.projectId });
  }

  const draft = draftResult.draft;
  const paragraphs = bodyParagraphs(draft);
  const citedSourceUrls = new Set(draft.footnotes.map((note) => normalizeUrl(note.url)));
  const sourcePayload = sourceResult.sources.filter((source) => citedSourceUrls.has(normalizeUrl(source.url))).map(({ title, url, content }) => ({ title, url, content }));
  const numberedParagraphs = paragraphs.map((text, paragraph) => ({ paragraph, sentences: splitSentences(text).map((text, sentenceIndex) => ({ sentenceIndex, text })) }));
  console.error(`[4/4] Auditing ${paragraphs.length} paragraphs claim by claim...`);
  const semantic = await completeJson({
    system: `You are a strict source-grounding auditor. Audit every externally checkable factual claim in the essay, sentence by sentence, against ONLY the supplied source text belonging to its in-text footnote markers. Use CITATIONS to resolve each marker to its page. Do not select a different page as a replacement. If a cited page directly supports the sentence, list that cited URL in supportingUrls. An uncited external fact is unsupported, even if another supplied page happens to support it. Do not use your own knowledge to mark a claim supported. "supported" means the complete material claim is directly entailed by one or more source texts. "partially_supported" means only part is entailed or the sentence adds precision, causation, scope, dates, numbers, or interpretation absent from the cited text. "common_knowledge" is limited to basic facts an ordinary secondary-school reader would know. "logical_inference" must follow directly from supported prior sentences without introducing a new external fact. "nonfactual" applies to explicitly proposed design features, future plans, evaluation metrics, recommendations, and aims without claiming proven effectiveness or existing implementations. Do not require sources to have already implemented a clearly labeled proposal. Verify any factual background embedded in a proposal separately. "unsupported" means no supplied text entails a claimed external fact. Return EVERY supplied sentence exactly once using its paragraph and sentenceIndex. Return indexes, never copied sentence text. Return raw JSON only.`,
    user: `SOURCES:\n${JSON.stringify(sourcePayload)}\n\nCITATIONS:\n${JSON.stringify(draft.footnotes.map(({ id, url }) => ({ id, url })))}\n\nESSAY PARAGRAPHS:\n${JSON.stringify(numberedParagraphs)}\n\nReturn {"claims":[{"paragraph":0,"sentenceIndex":0,"status":"supported|partially_supported|common_knowledge|logical_inference|nonfactual|unsupported","supportingUrls":["exact URL"],"reason":"brief explanation"}]}.`,
    temperature: 0.1,
    maxTokens: 10000,
    thinking: false,
    tries: 2,
    parseTries: 2,
    retryTempDelta: 0,
    schema: AuditSchema,
  }, nimChatLong);

  const evidenceFailures = verifyEvidence(draft.evidence, draft.footnotes, sourcesTextMap(sourceResult.sources));
  const approvedUrls = new Set(sourceResult.sources.map((s) => normalizeUrl(s.url)));
  const unapprovedFootnotes = draft.footnotes.filter((f) => !approvedUrls.has(normalizeUrl(f.url || "")));
  const duplicateEvidenceParagraphs = new Set(draft.evidence.map((e) => e.paragraph));
  const sectionStart = draft.introduction.length;
  const sectionEnd = sectionStart + draft.sections.flatMap((s) => s.paragraphs).length;
  const missingBodyEvidence = [];
  for (let i = sectionStart; i < sectionEnd; i++) if (!duplicateEvidenceParagraphs.has(i)) missingBodyEvidence.push(i);

  const claims = numberedParagraphs.flatMap(({ paragraph, sentences }) => sentences.map(({ sentenceIndex, text: actualSentence }) => {
    const claim = semantic.claims.find((item) => item.paragraph === paragraph && item.sentenceIndex === sentenceIndex)
      || { paragraph, sentenceIndex, status: "unsupported", supportingUrls: [], reason: "The independent reviewer omitted this sentence." };
    const citedUrls = markerUrls(actualSentence, draft.footnotes);
    const supportingUrls = claim.supportingUrls.map(normalizeUrl).filter(Boolean);
    const citationMatchesSupport = supportingUrls.length === 0 || supportingUrls.some((url) => citedUrls.includes(url));
    const needsCitation = claim.status === "supported" || claim.status === "partially_supported" || claim.status === "unsupported";
    return { ...claim, sentence: actualSentence, citedUrls, citationPresent: citedUrls.length > 0, citationMatchesSupport, needsCitation };
  }));

  const factualProblems = claims.filter((c) =>
    c.status === "unsupported" || c.status === "partially_supported" ||
    (c.needsCitation && !c.citationPresent) || (c.status === "supported" && !c.citationMatchesSupport)
  );
  const missingFactualEvidence = missingBodyEvidence.filter((paragraph) =>
    claims.some((claim) => claim.paragraph === paragraph && claim.needsCitation)
  );
  const bodyWords = paragraphs.join(" ").replace(/\[\^\d+\]/g, "").split(/\s+/).filter(Boolean).length;
  const shallowSectionParagraphs = [];
  let flatIndex = draft.introduction.length;
  for (const section of draft.sections) {
    for (const text of section.paragraphs) {
      const sentences = splitSentences(text).length;
      const words = text.replace(/\[\^\d+\]/g, "").split(/\s+/).filter(Boolean).length;
      if (sentences < 3 || words < 60) shallowSectionParagraphs.push({ paragraph: flatIndex, sentences, words, text: text.slice(0, 160) });
      flatIndex++;
    }
  }
  const withinTolerance = Math.abs(bodyWords - wordTarget) <= tolerance;
  const incompleteEnds = [...draft.introduction, ...draft.conclusion].some((paragraph) => paragraph.replace(/\[\^\d+\]/g, "").split(/\s+/).filter(Boolean).length < 30);
  let repetitionError = null;
  try { assertNoRepeatedSentences(draft); } catch (error) { repetitionError = error.message; }
  const report = {
    result: factualProblems.length === 0 && evidenceFailures.length === 0 && unapprovedFootnotes.length === 0 && missingFactualEvidence.length === 0 && shallowSectionParagraphs.length === 0 && withinTolerance && !repetitionError && !incompleteEnds ? "PASS" : "FAIL",
    topic,
    target: wordTarget,
    tolerance,
    routeWordCount: draftResult.wordCount,
    bodyWordCount: bodyWords,
    withinTolerance,
    repetitionError,
    incompleteEnds,
    sourcesCollected: sourceResult.sources.length,
    footnotes: draft.footnotes.length,
    worksCited: draft.worksCited.length,
    evidenceItems: draft.evidence.length,
    evidenceFailures,
    unapprovedFootnotes: unapprovedFootnotes.map((f) => ({ id: f.id, url: f.url })),
    missingBodyEvidence,
    missingFactualEvidence,
    shallowSectionParagraphs,
    claimsAudited: claims.length,
    statusCounts: Object.fromEntries([...new Set(claims.map((c) => c.status))].map((status) => [status, claims.filter((c) => c.status === status).length])),
    factualProblems,
    issues: draftResult.issues,
    projectId: draftResult.projectId,
    versionId: draftResult.versionId,
    downloadUrl: `${baseUrl}${draftResult.downloadUrl}`,
  };
  require("node:fs").mkdirSync("tests/artifacts", { recursive: true });
  require("node:fs").writeFileSync("tests/artifacts/live-audit-current.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== "PASS") process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
