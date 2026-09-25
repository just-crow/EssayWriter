import { z } from "zod";

export const StructureParagraphSchema = z.object({
  point: z.string(),
  criterion: z.string().default(""),
  strand: z.string().default(""),
});

export const StructureSectionSchema = z.object({
  heading: z.string(),
  paragraphs: z.array(StructureParagraphSchema),
});

export const StructureSchema = z.object({
  thesis: z.string(),
  sections: z.array(StructureSectionSchema),
  checklist: z.array(z.string()),
});

export const SourceItemSchema = z.object({
  id: z.string().default(""),
  author: z.string().default(""),
  title: z.string().default(""),
  container: z.string().default(""),
  publisher: z.string().default(""),
  year: z.string().default(""),
  url: z.string().default(""),
  accessed: z.string().default(""),
  supports: z.string().default(""),
  kind: z.string().default("web"),
  /** Full page text (Tavily Extract, truncated). The draft is written from
   * these texts, not from metadata. Empty = snippet-only fallback. */
  content: z.string().default(""),
});

export const DraftFootnoteSchema = z.object({
  id: z.number(),
  author: z.string().default(""),
  title: z.string().default(""),
  publisher: z.string().default(""),
  year: z.string().default(""),
  url: z.string().default(""),
  accessed: z.string().default(""),
});

export const DraftSectionSchema = z.object({
  heading: z.string().default(""),
  paragraphs: z.array(z.string()),
});

export const DraftSchema = z.object({
  title: z.string().default("Untitled Essay"),
  introduction: z.array(z.string()).default([]),
  sections: z.array(DraftSectionSchema).default([]),
  conclusion: z.array(z.string()).default([]),
  footnotes: z.array(DraftFootnoteSchema).default([]),
  worksCited: z.array(z.string()).default([]),
  coverage: z
    .array(
      z.object({
        item: z.string(),
        met: z.boolean().default(true),
        location: z.string().default(""),
      })
    )
    .default([]),
});

export type EssayStructure = z.infer<typeof StructureSchema>;
export type SourceItem = z.infer<typeof SourceItemSchema>;
export type EssayDraft = z.infer<typeof DraftSchema>;
