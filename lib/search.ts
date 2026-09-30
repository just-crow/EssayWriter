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
  /** Every query that returned this page, retained through URL deduplication. */
  queries?: string[];
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

/** True for long ALL-CAPS titles, which are usually file-dump labels
 * rather than real article titles. */
export function isShoutingTitle(raw: string): boolean {
  const t = (raw || "").trim();
  return t.length >= 24 && /^[A-Z0-9\s\-–:;,.()&']+$/.test(t) && /[A-Z]{4,}/.test(t);
}

/** Repair double-encoded UTF-8 sequences common in search-result titles
 * (e.g. neuronal "â€“" for an en dash). Generic byte-level fix, independent
 * of subject or site. */
export function repairMojibake(text: string): string {
  const table: Array<[RegExp, string]> = [
    [/â€“/g, "–"], [/â€”/g, "–"], [/â€™/g, "'"], [/â€˜/g, "'"], [/â€œ/g, "\u201C"], [/â€/g, "\u201D"],
    [/Ã©/g, "é"], [/Ã¨/g, "è"], [/Ãª/g, "ê"], [/Ã«/g, "ë"], [/Ã®/g, "î"], [/Ã´/g, "ô"],
    [/Ã¶/g, "ö"], [/Ã¼/g, "ü"], [/Ã§/g, "ç"], [/Ã±/g, "ñ"], [/Ã¡/g, "á"], [/Ã /g, "à"],
    [/Â /g, " "], [/Â/g, ""],
  ];
  let out = text;
  for (const [pattern, fix] of table) out = out.replace(pattern, fix);
  return out;
}

/** Clean raw search titles: strip (PDF) prefixes, file extensions,
 * excessive punctuation and ALL-CAPS shouting while preserving meaning.
 * Em dashes become en dashes so titles comply with the essay style ban
 * that covers footnotes and Works Cited. */
export function cleanSourceTitle(raw: string): string {
  // Mojibake runs (a replacement char plus stray question marks) stand for
  // a mangled dash or separator in search-result titles.
  let t = repairMojibake(raw || "").replace(/\s*�+\?*\s*/g, " - ").replace(/[�\u0000-\u001F\u007F-\u009F]/g, "").trim();
  t = t.replace(/^\(?\s*PDF\s*\)?\s*[-–:|.]?\s*/i, "");
  t = t.replace(/\.(pdf|docx?|pptx?)\s*$/i, "");
  t = t.replace(/\s*[|·•\-–—]+\s*$/g, "").trim();
  t = t.replace(/\s{2,}/g, " ").replace(/\.{2,}/g, "").replace(/—/g, "–").trim();
  // Title-case shouting while preserving meaning.
  if (isShoutingTitle(t)) {
    const lower = t.toLowerCase();
    t = lower.replace(/(^|[.!?]\s+)([a-z])/g, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
    t = t.charAt(0).toUpperCase() + t.slice(1);
  }
  return t || raw.trim();
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
      title: cleanSourceTitle(w.title),
      container: "",
      publisher: w.publisher || host,
      year: yearFrom(w.date),
      url: w.url,
      accessed,
      // Search hits are candidates, not proof that one page supports every
      // section whose query returned it. Show only its strongest query match.
      supports: `Relevant to ${labels.get(w.query) ?? "general background"}`,
      kind: kindForHost(host || w.publisher),
      content: "",
    };
  });
}

/** Per-query upper bound so one slow search cannot hang the whole stage. */
const QUERY_TIMEOUT_MS = 20_000;
const MAX_QUERIES = 18;

/** Per-extract upper bound so page fetching cannot hang the stage. */
const EXTRACT_TIMEOUT_MS = 30_000;
/** Retain long articles while bounding storage and verifier prompt size. */
export const MAX_SOURCE_CHARS = 100_000;
/** Eighteen pages plus JSON escaping and source metadata. */
export const MAX_SOURCES_JSON_CHARS = 4_000_000;

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
    const s = `${host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
    return s.toLowerCase();
  } catch {
    return "";
  }
}

const DISALLOWED_DOMAINS = new Set([
  "archive.org",
  "facebook.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "reddit.com",
  "quora.com",
  "pinterest.com",
  "fiverr.com",
  "upwork.com",
  "freelancer.com",
  "linkedin.com",
  "medium.com",
  "substack.com",
  "tumblr.com",
  "slideshare.net",
  "scribd.com",
  "coursehero.com",
  "chegg.com",
  "brainly.com",
  "quizlet.com",
  "toptal.com",
  "guru.com",
]);

export function isDisallowedUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    for (const d of DISALLOWED_DOMAINS) {
      if (host === d || host.endsWith(`.${d}`)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function qualityWeight(w: WebSource): number {
  let score = w.score;
  const host = (w.publisher || "").toLowerCase();
  const path = (() => { try { return new URL(w.url).pathname.toLowerCase(); } catch { return ""; } })();
  // Academic & Government domains get top priority
  if (host.endsWith(".edu") || host.endsWith(".gov") || /(^|\.)(ac\.[a-z]{2,}|gov\.[a-z]{2,})$/.test(host)) {
    score += 0.5;
  }
  // Major peer-reviewed and scientific publishers, reference works, primary sources
  if (
    /nature\.com|springer\.com|sciencedirect\.com|plos\.org|wiley\.com|frontiersin\.org|cell\.com|thelancet\.com|nejm\.org|bmj\.com|tandfonline\.com|oup\.com|cambridge\.org|jstor\.org|nih\.gov|biorxiv\.org|arxiv\.org|semanticscholar\.org|pubmed|britannica\.com|worldbank\.org|un\.org|fao\.org|ourworldindata\.org/.test(
      host
    )
  ) {
    score += 0.4;
  }
  // Study-format pages (revision notes, flashcards, homework help) are
  // background at best, whichever site hosts them. Detect by URL and title
  // format, never by site name, and keep them as fallback below substantive
  // pages.
  const title = (w.title || "").toLowerCase();
  if (
    /\/(notes?|study-guides?|study_guides?|key-terms?|key_terms?|flashcards?|homework-help?|past-papers?|practice-questions?)\//.test(path) ||
    /\b(flashcards?|study guides?|key terms?|homework help|past papers?|practice questions?|revision notes?|vocab(ulary)?\s+definitions?)\b/.test(title)
  ) {
    score -= 0.45;
  }
  // Titles that are file-dump labels or ALL-CAPS shouting signal weak evidence.
  if (/^\(?\s*pdf\s*\)?[\s\-–:|.]/.test(w.title || "") || isShoutingTitle(w.title || "")) {
    score -= 0.15;
  }
  return score;
}

export function sanitizePageMarkdown(raw: string): string {
  if (!raw) return "";
  return raw
    // Strip image tags: ![alt](url) -> ""
    .replace(/!\[.*?\](?:\([^\)]*\))?/g, "")
    // Convert markdown links to plain text: [Anchor](url) -> Anchor
    .replace(/\[([^\]]+)\](?:\([^\)]*\))?/g, "$1")
    // Clean trailing markdown link remnants like ](https://...
    .replace(/\]\([a-zA-Z0-9_+.~#?&=/%:-\s]*/g, "")
    // Strip HTML tags
    .replace(/<[^>]+>/g, " ")
    // Clean excessive spaces and newlines
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
      queries: [query],
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
    if (isDisallowedUrl(r.url)) continue;
    let publisher = "";
    try {
      publisher = new URL(r.url).hostname.replace(/^www\./, "");
    } catch {
      publisher = "";
    }
    out.push({
      title: r.title,
      url: r.url,
      snippet: sanitizePageMarkdown((r.content ?? "").slice(0, 600)),
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
    if (!prev) {
      best.set(n, s);
      continue;
    }
    const queries = [...new Set([...(prev.queries ?? [prev.query]), ...(s.queries ?? [s.query])])];
    best.set(n, { ...(s.score > prev.score ? s : prev), queries });
  }
  return [...best.values()].sort((a, b) => qualityWeight(b) - qualityWeight(a));
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
  const targets = urls.filter((u) => normalizeUrl(u)).slice(0, 18);
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
      const rawText = r.content || r.raw_content || "";
      const text = sanitizePageMarkdown(rawText).slice(0, MAX_SOURCE_CHARS);
      if (text) out.set(normalizeUrl(r.url), text);
    }
  } catch {
    // extraction is a quality upgrade; snippets remain the fallback
  }
  return out;
}
