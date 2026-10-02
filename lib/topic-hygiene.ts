/**
 * Institutional-boilerplate hygiene for retrieval and relevance.
 *
 * Users paste instruction sheets whose header is the school letterhead
 * ("DRUGA GIMNAZIJA SARAJEVO IB MIDDLE YEARS PROGRAMME YEAR FIVE"), and that
 * header sometimes lands in the topic box. Searching it returns the school's
 * own pages instead of essay evidence. This module detects header-like
 * topics with generic, language-agnostic signals (school/program/year
 * markers plus the absence of any essay-task verb) and falls back to the
 * outline, which carries the real subject. No school names, topics, or
 * sites are listed anywhere: only generic header vocabulary.
 */

/** Multiword institutional markers, matched before single words. Only
 * phrases that never occur in genuine essay subjects: generic level names
 * like "high school" stay ordinary words (the density ratio handles them). */
const INSTITUTIONAL_PHRASES = [
  "middle years",
  "instruction sheet",
];

/** Single institutional words (lowercase, singular-ish; plurals stripped). */
const INSTITUTIONAL_WORDS = new Set(
  "school schools schooling college colleges university universities academy academies institute institutes institution institutions gimnazija gymnasium gymnasia srednja skola schule escuela lycee lyceum kindergarten preschool programme programmes program programs curriculum curricula syllabus syllabi years year grade grades class classes semester semesters ib myp pyp dp diploma diplomas assignment assignments assessment assessments criteria criterion instructions sheet sheets task tasks rubric rubrics strand strands student students teacher teachers principal education".split(" ")
);

/** Markers that only appear in administrative headers, never essay questions. */
const HEADER_MARKERS =
  /\b(year|grade|programme|program|myp|pyp|\bib\b|diploma|school|schools|college|university|sheet|rubric|criteri|strand|assignment)\b/i;

/** Verbs and frames that make a segment an essay question, never a header. */
const TASK_VERBS =
  /\b(should|to what extent|evaluate|discuss|analy[sz]e|compare|contrast|impact|effect|effects|affect|how|why|whether|role of|importance|influence|cause|explain|assess\w*|justify|critic|comment)\b|\?/i;

function normalizeWord(raw: string): string {
  let w = raw.toLowerCase();
  if (w.endsWith("ss")) return w;
  if (w.endsWith("s") && w.length > 3) w = w.slice(0, -1);
  return w;
}

function segmentWords(segment: string): string[] {
  let lowered = ` ${segment.toLowerCase()} `;
  for (const phrase of INSTITUTIONAL_PHRASES) {
    if (lowered.includes(phrase)) lowered = lowered.split(phrase).join(` ${phrase.split(" ")[0]}_phrase `);
  }
  return (lowered.match(/[a-zšđžćčâêîôûäöüß-]{2,}/g) ?? []).map(normalizeWord);
}

/** True when a topic segment reads as institutional boilerplate rather than
 * an essay subject: dense in header vocabulary, carrying a header marker,
 * and free of any essay-task verb. */
export function isBoilerplateSegment(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return false;
  if (TASK_VERBS.test(trimmed)) return false;
  const words = segmentWords(trimmed);
  const content = words.filter((w) => w !== "phrase");
  if (content.length === 0) return false;
  // Multiword institutional phrases count once each, on top of word overlap.
  const instCount =
    content.filter((w) => INSTITUTIONAL_WORDS.has(w)).length +
    (trimmed.match(/middle years|instruction sheet/gi) ?? []).length;
  return instCount / content.length >= 0.4 && HEADER_MARKERS.test(trimmed);
}

export interface CleanTopic {
  /** Usable retrieval subject ("" when only boilerplate was given). */
  topic: string;
  /** True when boilerplate segments were removed. */
  boilerplate: boolean;
}

/** Strip institutional header segments from a topic. When nothing usable
 * remains, fall back to the outline thesis (the real subject); callers use
 * the raw topic only as a last resort. */
export function cleanTopicForRetrieval(topic: string, thesis?: string): CleanTopic {
  const segments = topic.split(/[,;|\n–—\-/()]+/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return { topic: thesis?.trim() || "", boilerplate: true };
  const kept = segments.filter((segment) => !isBoilerplateSegment(segment));
  if (kept.length === 0) return { topic: (thesis || "").trim(), boilerplate: true };
  const dropped = segments.length !== kept.length;
  return { topic: kept.join(" ").replace(/\s{2,}/g, " ").trim(), boilerplate: dropped };
}
