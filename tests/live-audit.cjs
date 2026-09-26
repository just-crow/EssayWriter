const { z } = require("zod");
require("@next/env").loadEnvConfig(process.cwd());
const { completeJson, nimChatLong } = require("../lib/nim.ts");
const { normalizeUrl } = require("../lib/search.ts");
const { splitSentences, verifyEvidence, sourcesTextMap } = require("../lib/validate.ts");
const { validateDraft } = require("../lib/validate.ts");
const { prisma } = require("../lib/db.ts");

const baseUrl = process.argv[2] || "http://localhost:3001";
const wordTarget = Number(process.argv[3] || 1200);
const tolerance = Number(process.argv[4] || 400);
const reuseLatest = process.argv.includes("--latest");
const reuseSources = process.argv.includes("--reuse-sources");
const topic = "How does sleep duration affect adolescent learning and mental health?";
const instructionText = "Write an evidence-based academic essay for an MYP student. Explain effects on attention, memory, school performance, mood, anxiety, and depression. Distinguish correlation from causation and acknowledge limits in the evidence. Use only the collected sources and cite every non-common factual claim.";

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${data.error || JSON.stringify(data)}`);
  return data;
}

const ClaimSchema = z.object({
  paragraph: z.number().int().min(0),
  sentence: z.string(),
  status: z.enum(["supported", "partially_supported", "common_knowledge", "logical_inference", "unsupported"]),
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
    const project = projects.find((p) => p.versions?.length);
    if (!project) throw new Error("No completed draft is available to audit.");
    const version = project.versions[0];
    const draft = JSON.parse(version.essayJson);
    sourceResult = { sources: await prisma.source.findMany({ where: { projectId: project.id } }) };
    draftResult = { projectId: project.id, versionId: version.id, draft, wordCount: version.wordCount, issues: validateDraft(draft), downloadUrl: `/api/download/${version.id}` };
    console.error(`[2/4] Loaded ${sourceResult.sources.length} saved source snapshots.`);
    console.error("[3/4] Reusing the saved production draft.");
  } else if (reuseSources) {
    console.error("[1/4] Loading the latest live source collection...");
    const projects = await prisma.project.findMany({ orderBy: { updatedAt: "desc" }, take: 20 });
    let project;
    for (const candidate of projects) {
      const sources = await prisma.source.findMany({ where: { projectId: candidate.id } });
      if (sources.length > 0) { project = { ...candidate, sources }; break; }
    }
    if (!project) throw new Error("No saved source collection is available.");
    sourceResult = { sources: project.sources };
    const structure = {
      thesis: "Adequate and regular sleep supports adolescent learning and mental health, while the largely associational evidence requires careful causal claims.",
      sections: [
        { heading: "Adolescent sleep needs", paragraphs: [{ point: "recommended duration and sleep patterns", criterion: "", strand: "" }] },
        { heading: "Attention and memory", paragraphs: [{ point: "attention, learning, and memory consolidation", criterion: "", strand: "" }] },
        { heading: "School performance", paragraphs: [{ point: "academic outcomes and competing explanations", criterion: "", strand: "" }] },
        { heading: "Mood and mental health", paragraphs: [{ point: "mood, anxiety, and depression", criterion: "", strand: "" }] },
        { heading: "Limits of the evidence", paragraphs: [{ point: "correlation, causation, measurement, and confounding", criterion: "", strand: "" }] },
      ], checklist: [],
    };
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
  const sourcePayload = sourceResult.sources.map(({ title, url, content }) => ({ title, url, content }));
  const numberedParagraphs = paragraphs.map((text, paragraph) => ({ paragraph, text }));
  console.error(`[4/4] Auditing ${paragraphs.length} paragraphs claim by claim...`);
  const semantic = await completeJson({
    system: `You are a strict source-grounding auditor. Audit every externally checkable factual claim in the essay, sentence by sentence, against ONLY the supplied source text. Do not use your own knowledge to mark a claim supported. "supported" means the complete material claim is directly entailed by one or more source texts. "partially_supported" means only part is entailed or the sentence adds precision, causation, scope, dates, numbers, or interpretation absent from the cited text. "common_knowledge" is limited to basic facts an ordinary secondary-school reader would know. "logical_inference" must follow directly from supported prior sentences without introducing a new external fact. "unsupported" means no supplied text entails it. Return every sentence containing an externally checkable factual claim. Copy each sentence exactly and return raw JSON only.`,
    user: `SOURCES:\n${JSON.stringify(sourcePayload)}\n\nESSAY PARAGRAPHS:\n${JSON.stringify(numberedParagraphs)}\n\nReturn {"claims":[{"paragraph":0,"sentence":"exact sentence","status":"supported|partially_supported|common_knowledge|logical_inference|unsupported","supportingUrls":["exact URL"],"reason":"brief explanation"}]}.`,
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

  const claims = semantic.claims.map((claim) => {
    const original = paragraphs[claim.paragraph] || "";
    const actualSentence = splitSentences(original).find((s) => s === claim.sentence || s.replace(/\[\^\d+\]/g, "").trim() === claim.sentence.replace(/\[\^\d+\]/g, "").trim()) || claim.sentence;
    const citedUrls = markerUrls(actualSentence, draft.footnotes);
    const supportingUrls = claim.supportingUrls.map(normalizeUrl).filter(Boolean);
    const citationMatchesSupport = supportingUrls.length === 0 || supportingUrls.some((url) => citedUrls.includes(url));
    const needsCitation = claim.status === "supported" || claim.status === "partially_supported" || claim.status === "unsupported";
    return { ...claim, citedUrls, citationPresent: citedUrls.length > 0, citationMatchesSupport, needsCitation };
  });

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
  const withinTolerance = Math.abs(draftResult.wordCount - wordTarget) <= tolerance;
  const report = {
    result: factualProblems.length === 0 && evidenceFailures.length === 0 && unapprovedFootnotes.length === 0 && missingFactualEvidence.length === 0 && shallowSectionParagraphs.length === 0 && withinTolerance ? "PASS" : "FAIL",
    topic,
    target: wordTarget,
    tolerance,
    routeWordCount: draftResult.wordCount,
    bodyWordCount: bodyWords,
    withinTolerance,
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
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== "PASS") process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
