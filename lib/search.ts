export type WebSource = {
  title: string;
  url: string;
  snippet: string;
  publisher: string;
  date: string;
  /** Tavily relevance score (higher is better). */
  score: number;
  /** The query text that surfaced this result. */
  query: string;
};

import type { SourceItem } from "./essay-types";

/** Crude but honest kind classification from hostname. Unknowns stay "web". */
function kindForHost(host: string): string {
  const h = host.toLowerCase();
  if (h.endsWith(".edu") || /(^|\.)ac\.[a-z]{2,}$/.test(h)) return "academic";
  if (h.endsWith(".gov") || /(^|\.)gov\.[a-z]{2,}$/.test(h)) return "primary";
  return "web";
}

function yearFrom(date: string): string {
  const m = (date || "").match(/(19|20)\d{2}/);
  return m ? m[0] : "";
}

/**
 * Build source records deterministically from verified search results.
 * No model involved: every field is observed (title, URL, publisher, date,
 * page text) or explicitly empty. Authors stay empty when unobserved so
 * citations render title-first instead of guessing a name.
 */
export function buildSources(
  results: WebSource[],
  labels: Map<string, string>,
  accessed: string
): SourceItem[] {
  return results.map((w, i) => {
    let host = "";
    try {
      host = new URL(w.url).hostname.replace(/^www\./, "");
    } catch {
      host = w.publisher;
    }
    return {
      id: String(i + 1),
      author: "",
      title: w.title,
      container: "",
      publisher: w.publisher || host,
      year: yearFrom(w.date),
      url: w.url,
      accessed,
      supports: `Relevant to ${labels.get(w.query) ?? "general background"}`,
      kind: kindForHost(host || w.publisher),
      content: "",
    };
  });
}

/** Per-query upper bound so one slow search cannot hang the whole stage. */
const QUERY_TIMEOUT_MS = 20_000;
const MAX_QUERIES = 6;

/** Per-extract upper bound so page fetching cannot hang the stage. */
const EXTRACT_TIMEOUT_MS = 30_000;
/** Max characters of page text kept per source (bounds prompt size). */
export const MAX_SOURCE_CHARS = 3000;

/** Normalize for membership checks: lowercase host, trim trailing slash,
 * drop tracking params and fragments. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|igsh)/i.test(p)) u.searchParams.delete(p);
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    let s = `${host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
    return s.toLowerCase();
  } catch {
    return "";
  }
}

async function oneQuery(
  key: string,
  query: string,
  maxPerQuery: number
): Promise<WebSource[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      query,
      search_depth: "advanced",
      max_results: maxPerQuery,
      include_answer: false,
    }),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      published_date?: string;
      score?: number;
    }>;
  };
  const out: WebSource[] = [];
  for (const r of data.results ?? []) {
    if (!r.url || !r.title) continue;
    if (!normalizeUrl(r.url)) continue;
    if (r.url.includes("archive.org")) continue;
    let publisher = "";
    try {
      publisher = new URL(r.url).hostname.replace(/^www\./, "");
    } catch {
      publisher = "";
    }
    out.push({
      title: r.title,
      url: r.url,
      snippet: (r.content ?? "").slice(0, 600),
      publisher,
      date: r.published_date ?? "",
      score: typeof r.score === "number" ? r.score : 0,
      query,
    });
  }
  return out;
}

/**
 * Live web search for real, verifiable sources.
 * Queries run in PARALLEL, each bounded by QUERY_TIMEOUT_MS, so the stage
 * can never hang on a slow provider. Returns [] when no key is set or
 * nothing usable comes back — callers treat that as "no verified pages".
 */
export async function liveSearch(
  queries: string[],
  maxPerQuery = 5
): Promise<WebSource[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];
  const settled = await Promise.allSettled(
    queries.slice(0, MAX_QUERIES).map((q) => oneQuery(key, q, maxPerQuery))
  );
  const flat = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  // dedupe by normalized URL, keeping the highest score, then rank best first
  const best = new Map<string, WebSource>();
  for (const s of flat) {
    const n = normalizeUrl(s.url);
    if (!n) continue;
    const prev = best.get(n);
    if (!prev || s.score > prev.score) best.set(n, s);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/**
 * Fetch full page text for an already-verified shortlist (basic extract).
 * Called AFTER the URL membership check, so credits are never spent on
 * invented URLs. Returns url -> markdown text (truncated). URLs that fail
 * to extract map to "" and callers fall back to the search snippet.
 */
export async function extractPages(urls: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const key = process.env.TAVILY_API_KEY;
  const targets = urls.filter((u) => normalizeUrl(u)).slice(0, 12);
  if (!key || targets.length === 0) return out;
  try {
    const res = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        urls: targets,
        extract_depth: "basic",
        format: "markdown",
      }),
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    });
    if (!res.ok) return out;
    const data = (await res.json()) as {
      results?: Array<{ url?: string; raw_content?: string; content?: string }>;
    };
    for (const r of data.results ?? []) {
      if (!r.url) continue;
      const text = (r.content || r.raw_content || "").trim().slice(0, MAX_SOURCE_CHARS);
      if (text) out.set(normalizeUrl(r.url), text);
    }
  } catch {
    // extraction is a quality upgrade; snippets remain the fallback
  }
  return out;
}
