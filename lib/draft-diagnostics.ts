import { z } from "zod";
import type { EssayDraft } from "./essay-types";
import type { ParagraphTask } from "./paragraph-plan";

const PartSchema = z.object({ heading: z.string(), words: z.number().int().min(0), sentences: z.number().int().min(0) });
export const DraftDiagnosticsSchema = z.object({
  plan: z.array(z.object({heading: z.string(), targetWords: z.number().int().min(0), findings: z.number().int().min(0), works: z.number().int().min(0)})),
  stages: z.array(z.object({stage: z.string(), words: z.number().int().min(0), parts: z.array(PartSchema)})),
  removed: z.array(z.string()),
  depthRepair: z.object({attempted: z.boolean(), addedWords: z.number().int().min(0), reason: z.string().optional()}).optional(),
  topicReviewSkipped: z.string().optional(),
});
export type DraftDiagnostics = z.infer<typeof DraftDiagnosticsSchema>;

const part = (heading: string, paragraphs: string[]) => ({
  heading,
  words: paragraphs.join(" ").replace(/\[\^\d+\]/g, "").split(/\s+/).filter(Boolean).length,
  sentences: paragraphs.join(" ").split(/(?<=[.!?])\s+/).filter(Boolean).length,
});

export function snapshotDraft(draft: EssayDraft, stage: string): DraftDiagnostics["stages"][number] {
  const parts = [part("Introduction", draft.introduction),
    ...draft.sections.map(section => part(section.heading, section.paragraphs)),
    part("Conclusion", draft.conclusion)];
  return {
    stage, words: parts.reduce((sum, item) => sum + item.words, 0), parts,
  };
}

export function plannedEvidence(tasks: ParagraphTask[], headings: string[]): DraftDiagnostics["plan"] {
  return tasks.map(task => ({
    heading: task.section < 0 ? "Introduction" : headings[task.section],
    targetWords: task.words,
    findings: task.assigned.length,
    works: new Set(task.assigned.map(finding => finding.sourceId)).size,
  }));
}
