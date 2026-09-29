import { NextResponse } from "next/server";
import { z } from "zod";
import { type SourceItem } from "@/lib/essay-types";
import { liveSearch, normalizeUrl, extractPages, buildSources, type WebSource } from "@/lib/search";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Fewer verified pages than this and the run refuses instead of inventing. */
const MIN_VERIFIED = 3;

const Body = z.object({
  topic: z.string().min(1).max(500),
  structureJson: z.string().min(2).max(30000),
  projectId: z.string().nullish(),
  needed: z.number().int().min(3).max(30).default(18),
});

type SourcesInput = z.infer<typeof Body>;

const today = new Date().toLocaleDateString("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export interface SourcesResult {
  sources: SourceItem[];
  liveSearchUsed: boolean;
  liveHits: number;
}

/** Give every section a search before spending queries on individual points,
 * then reserve the last slots for evaluative angles (criticism, evidence,
 * data) so the essay gets counter-arguments instead of descriptive echoes. */
export function planSourceQueries(topic: string, structureJson: string): Array<{ text: string; label: string }> {
  const general = { text: topic, label: "general background" };
  try {
    const structure = JSON.parse(structureJson) as {
      sections?: Array<{ heading?: string; paragraphs?: Array<{ point?: string }> }>;
    };
    const sections = (structure.sections ?? []).filter((section) => section.heading?.trim());
    if (!sections.length) return [general];
    const searchStopwords = new Set("about advantages and benefits challenges effects essay evaluation impact limitations of on planning role the with".split(" "));
    const subject = (topic.toLowerCase().match(/[\p{L}\p{N}-]+/gu) ?? [])
      .filter((word) => word.length > 2 && !searchStopwords.has(word)).slice(0, 10).join(" ") || topic;
    const headingQueries = sections.map((section) => ({
      text: `${subject} ${section.heading}`.trim(),
      label: `the section “${section.heading}”`,
    }));
    const pointQueries = [0, 1].flatMap((index) => sections.flatMap((section) => {
      const point = section.paragraphs?.[index]?.point?.replace(/^Question to investigate:\s*/i, "").trim();
      return point ? [{ text: `${subject} ${point.slice(0, 140)}`, label: `the section “${section.heading}”` }] : [];
    }));
    const evaluative = [
      { text: `${subject} criticism evaluation evidence`, label: "evaluation and criticism" },
      { text: `${subject} data statistics case study`, label: "evidence and data" },
    ];
    const unique = new Map<string, { text: string; label: string }>();
    for (const query of [...headingQueries, general, ...pointQueries, ...evaluative]) {
      if (!unique.has(query.text)) unique.set(query.text, query);
    }
    return [...unique.values()].slice(0, 18);
  } catch {
    return [general];
  }
}

/** Reserve pages found for each section, then fill remaining slots by rank. */
export function selectBalancedSources(
  results: WebSource[],
  queries: Array<{ text: string; label: string }>,
  needed: number
): WebSource[] {
  // A category or search page can be useful when a section has no other hit,
  // but it should not take a slot from a substantive page for that section.
  const isListing = (result: WebSource) => {
    try { return /(?:^|\/)(?:category|tag|topics|search)(?:\/|$)/i.test(new URL(result.url).pathname); }
    catch { return false; }
  };
  const ranked = [...results].sort((a, b) => Number(isListing(a)) - Number(isListing(b)));
  const sections = [...new Set(queries.map((query) => query.label).filter((label) => label !== "general background"))];
  const queryLabels = new Map(queries.map((query) => [query.text, query.label]));
  const chosen: WebSource[] = [];
  const used = new Set<string>();
  const add = (result: WebSource | undefined) => {
    if (!result || chosen.length >= needed) return;
    const url = normalizeUrl(result.url);
    if (url && !used.has(url)) { used.add(url); chosen.push(result); }
  };
  for (let round = 0; round < 2 && chosen.length < needed; round++) {
    for (const label of sections) {
      const strongest = ranked.find((result) => queryLabels.get(result.query) === label && !used.has(normalizeUrl(result.url)));
      const broader = ranked.find((result) => (result.queries ?? [result.query])
        .some((query) => queryLabels.get(query) === label) && !used.has(normalizeUrl(result.url)));
      add(strongest ?? broader);
    }
  }
  for (const result of ranked) add(result);
  return chosen;
}

export async function runSourcesPipeline(
  input: SourcesInput,
  reportStage?: (s: string) => void
): Promise<SourcesResult> {
  const qlist = planSourceQueries(input.topic, input.structureJson);
  const labels = new Map(qlist.map((q) => [q.text, q.label]));

  reportStage?.("Searching the web…");
  const web = await liveSearch(
    qlist.map((q) => q.text),
    4
  );
  reportStage?.(`Found ${web.length} verified pages — building the list…`);

  // Kill-switch: too few verified pages is an error, not an invitation
  // for anyone (model or code) to invent sources.
  if (web.length < MIN_VERIFIED) {
    throw new Error(
      `Live search returned only ${web.length} verifiable page${web.length === 1 ? "" : "s"} (need at least ${MIN_VERIFIED}). Refine the topic or outline and try again. No sources were invented.`
    );
  }

  // Deterministic shortlist: represent each searched section before global rank.
  // No model involved — every field below is observed or explicitly empty.
  const target = Math.min(input.needed, web.length);
  const shortlist = selectBalancedSources(web, qlist, target);
  const allowed = new Set(shortlist.map((w) => normalizeUrl(w.url)));
  const built = buildSources(shortlist, labels, today);

  // Defensive invariant: built entries must all come from verified pages.
  const bad = built.filter((s) => !allowed.has(normalizeUrl(s.url || "")));
  if (built.length === 0 || bad.length > 0) {
    throw new Error(
      "Source verification failed unexpectedly. Try gathering again."
    );
  }
  const parsed = { sources: built };
  reportStage?.("Fetching full page texts…");
  const texts = await extractPages(parsed.sources.map((s) => s.url));
  const snippets = new Map(shortlist.map((w) => [normalizeUrl(w.url), w.snippet]));
  let sources = parsed.sources.map((s) => ({
    ...s,
    content: (texts.get(normalizeUrl(s.url || "")) || snippets.get(normalizeUrl(s.url || "")) || "").trim(),
  }));
  // Snippet-only pages (weak extracts) produce generic memory-written essays
  // like the Malthus sample. Require real page text when available.
  const substantive = sources.filter((s) => s.content.length >= 300);
  if (substantive.length >= MIN_VERIFIED) {
    sources = substantive;
  } else {
    // Keep the longest available rather than the rank order when everything
    // is thin, so at least the writer sees the most text possible.
    sources = [...sources].sort((a, b) => b.content.length - a.content.length);
  }

  if (input.projectId) {
    reportStage?.("Saving sources…");
    // Older versions still need their source texts for evidence verification.
    const saved = await prisma.source.findMany({ where: { projectId: input.projectId } });
    for (const s of sources) {
      if (saved.some((old) => normalizeUrl(old.url) === normalizeUrl(s.url) && old.content === s.content)) continue;
      await prisma.source.create({
        data: {
          projectId: input.projectId,
          author: s.author,
          title: s.title,
          publisher: s.publisher || s.container,
          year: s.year,
            url: s.url,
            accessed: s.accessed,
            supports: s.supports,
            content: s.content,
        },
      });
    }
  }

  return { sources, liveSearchUsed: true, liveHits: web.length };
}

export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    // One code path everywhere: run the pipeline inside the request and
    // return the full result. (A previous background-job design broke on
    // serverless, where work queued after the response never runs.)
    const result = await runSourcesPipeline(body);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sources failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
