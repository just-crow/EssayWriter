import { normalizeUrl } from "./search";

/** Count a publication once across alternate views or matching mirrored
 * article titles. Evidence continues to bind to the exact original URL. */
export function workIdentity(work: {url?: string; title?: string}) {
  const title = (work.title || "").toLowerCase().split("|")[0].replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (title.length >= 40 && title.split(/\s+/).length >= 7) return `title:${title}`;
  try {
    const url = new URL(work.url || "");
    for (const key of ["view", "format", "output"]) if (/^(abstract|full|html|xml|xml-feed|pdf)$/i.test(url.searchParams.get(key) || "")) url.searchParams.delete(key);
    return normalizeUrl(url.toString());
  } catch { return ""; }
}
