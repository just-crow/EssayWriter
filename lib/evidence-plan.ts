import type { SourceItem } from "./essay-types";
import { sourcePassages } from "./source-passages";
import { normalizeUrl } from "./search";

const stopWords = new Set("about after also before being between could essay every from have into more only should source sources their there these they this through topic using were what when where which while with would your target minimum words factual findings section paragraph introduction conclusion instructions outline".split(" "));
function terms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z]{4,}/g) || []).map(word => word.replace(/s$/, "")).filter(word => !stopWords.has(word)));
}

/** Select observed passages before composition. Model-generated indexes are
 * never used: every finding comes directly from an actual page snapshot. */
export async function selectWritingEvidence(
  sources: SourceItem[], brief: string,
  options: { minimumCharacters?: number; minimumSources?: number } = {}
): Promise<SourceItem[]> {
  const wanted = terms(brief);
  const focus = terms(brief.split("\n")[0]);
  const bank = sources.map((source, sourceIndex) => ({ source, sourceIndex, passages: sourcePassages(source.content) }));
  const candidates = bank.flatMap(({ source, sourceIndex, passages }) => passages.map((text, passageIndex) => ({
    sourceIndex, passageIndex, text, tokens: terms(`${source.title || ""} ${text}`), titleTokens: terms(source.title || ""), url: normalizeUrl(source.url),
  }))).filter(item => item.url);
  const frequency = new Map<string, number>();
  for (const candidate of candidates) for (const token of candidate.tokens) frequency.set(token, (frequency.get(token) || 0) + 1);
  const ranked = candidates.map(candidate => ({ ...candidate,
    score: [...candidate.tokens].filter(token => wanted.has(token)).reduce((score, token) => score + Math.log(1 + candidates.length / (frequency.get(token) || 1)), 0)
      + [...focus].filter(token => candidate.titleTokens.has(token)).length * 10,
  })).sort((a, b) => b.score - a.score || b.text.length - a.text.length);
  const available = candidates.reduce((total, item) => total + item.text.length, 0);
  const minimum = available < 200 ? 0 : Math.min(available, Math.max(200, options.minimumCharacters || 200));
  const minimumWorks = options.minimumSources || 1;
  const selections = new Map<number, Set<number>>();
  const works = new Set<string>();
  let chars = 0;
  const select = (item: typeof ranked[number]) => {
    const indexes = selections.get(item.sourceIndex) || new Set<number>();
    if (indexes.has(item.passageIndex)) return;
    indexes.add(item.passageIndex); selections.set(item.sourceIndex, indexes);
    works.add(item.url); chars += item.text.length;
  };
  // Start with different works; then develop the strongest relevant material.
  // The quota is a floor: additional works can be selected for useful facts.
  for (const item of ranked) {
    if (works.size >= minimumWorks) break;
    if (!works.has(item.url)) select(item);
  }
  if (works.size < minimumWorks) throw new Error(`The collected pages do not contain readable passages from ${minimumWorks} distinct works. Gather more substantial sources or lower the minimum cited works.`);
  for (const item of ranked) {
    if (chars >= minimum && selections.size) break;
    select(item);
  }
  return [...selections].map(([sourceIndex, indexes]) => ({
    ...sources[sourceIndex],
    content: [...indexes].sort((a, b) => a - b).map(index => bank[sourceIndex].passages[index]).join("\n\n"),
  }));
}
