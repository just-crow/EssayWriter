import { NextResponse } from "next/server";
import { z } from "zod";
import { type SourceItem } from "@/lib/essay-types";
import { liveSearch, normalizeUrl, extractPages, buildSources } from "@/lib/search";
import { createJob, runJob } from "@/lib/jobs";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Fewer verified pages than this and the run refuses instead of inventing. */
const MIN_VERIFIED = 3;
/** No model call in this stage anymore, so attempts stay at 0. */
const JOB_TRIES = 1;

const Body = z.object({
  topic: z.string().min(1).max(500),
  structureJson: z.string().min(2).max(30000),
  projectId: z.string().nullish(),
  needed: z.number().int().min(3).max(30).default(12),
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

export async function runSourcesPipeline(
  input: SourcesInput,
  reportStage?: (s: string) => void
): Promise<SourcesResult> {
  // Derive search queries from outline points, keeping the outline label
  // each query came from so sources map back to sections deterministically.
  let qlist: Array<{ text: string; label: string }> = [
    { text: input.topic, label: "general background" },
  ];
  try {
    const s = JSON.parse(input.structureJson) as {
      sections?: Array<{ heading?: string; paragraphs?: Array<{ point?: string }> }>;
    };
    const pts = (s.sections ?? []).flatMap((sec) => {
      const label = sec.heading ? `the section “${sec.heading}”` : "general background";
      return [
        { text: `${input.topic} ${sec.heading ?? ""}`.trim(), label },
        ...((sec.paragraphs ?? [])
          .slice(0, 2)
          .map((p) => ({ text: `${input.topic} ${p.point ?? ""}`.trim(), label }))),
      ];
    });
    if (pts.length > 0) qlist = pts;
  } catch {
    // keep default
  }
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

  // Deterministic shortlist: best Tavily scores first, capped at target.
  // No model involved — every field below is observed or explicitly empty.
  const target = Math.min(input.needed, web.length);
  const shortlist = web.slice(0, target);
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
  const sources = parsed.sources.map((s) => ({
    ...s,
    content: texts.get(normalizeUrl(s.url || "")) || snippets.get(normalizeUrl(s.url || "")) || "",
  }));

  if (input.projectId) {
    reportStage?.("Saving sources…");
    await prisma.source.deleteMany({ where: { projectId: input.projectId } });
    for (const s of sources) {
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

    // Serverless (Vercel): background work after the response gets frozen,
    // so a queued job would never run and the client would poll forever.
    // Run the pipeline synchronously and return the full result instead.
    if (process.env.VERCEL) {
      const result = await runSourcesPipeline(body);
      return NextResponse.json({ ...result, jobId: null });
    }

    // Long-lived local server: background job + polling for live progress.
    const job = await createJob("sources", JOB_TRIES);
    runJob(job.id, (r) =>
      runSourcesPipeline(body, (s) => r.stage(s))
    );
    // Returns in milliseconds; the client polls GET /api/jobs/[id].
    return NextResponse.json({ jobId: job.id }, { status: 202 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sources failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
