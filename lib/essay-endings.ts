import type { EssayDraft } from "./essay-types";

/** Which of the two ends vanished under source checks (blank after audit).
 * The route treats a missing end as a retryable failure rather than
 * silently delivering a structurally broken essay. */
export function missingEnds(draft: EssayDraft): Array<"introduction" | "conclusion"> {
  const missing: Array<"introduction" | "conclusion"> = [];
  if (!draft.introduction.some((paragraph) => paragraph.trim())) missing.push("introduction");
  if (!draft.conclusion.some((paragraph) => paragraph.trim())) missing.push("conclusion");
  return missing;
}

/** An audit may remove an unsupported opening thesis or closing claim in its
 * entirety. Keep the verified body, and supply only nonfactual framing. */
export function ensureEssayEnds(draft: EssayDraft, topic: string): void {
  const sections = draft.sections.map(section => section.heading).filter(Boolean);
  const subjects = sections.length ? sections.slice(0, 3).join(" and ") : "the essay question";
  const subject = topic.trim().replace(/[.!?\s]+$/g, "").replace(/^./, character => character.toLowerCase());
  const framing = subject ? `The discussion examines ${subject}.` : `The discussion examines ${subjects}.`;
  if (!draft.introduction.some(paragraph => paragraph.trim())) {
    draft.introduction = [`${framing} It develops each part of the question from the cited evidence and keeps the final assessment within what those findings can establish.`];
  } else if (/^(?:these|those|this|such|however|therefore|consequently)\b/i.test(draft.introduction[0].trim())) {
    draft.introduction[0] = `${framing} ${draft.introduction[0].replace(/^\s*/, "")}`;
  }
  if (!draft.conclusion.some(paragraph => paragraph.trim())) {
    draft.conclusion = [`The preceding discussion provides a qualified answer to the essay question. Its conclusions rest on the findings already presented and on the limits identified in those sections.`];
  }
}
