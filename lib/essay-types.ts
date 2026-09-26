import { z } from "zod";

export const StructureParagraphSchema = z.object({
  point: z.string(),
  criterion: z.string().default(""),
  strand: z.string().default(""),
});

export const StructureSectionSchema = z.object({
  heading: z.string(),
  // Multiple bullet points per section are mandatory (never a single line).
  paragraphs: z.array(StructureParagraphSchema).min(3),
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

export const EvidenceSchema = z.object({
  /** 0-based index over introduction + section paragraphs + conclusion. */
  paragraph: z.number().int().min(0),
  /** Footnote id the quote is taken from. */
  source: z.number().int().min(1),
  /** Verbatim span (12+ chars) from that source's page text. */
  quote: z.string().min(1),
});

export const DraftSchema = z.object({
  title: z.string().default("Untitled Essay"),
  introduction: z.array(z.string()).default([]),
  sections: z.array(DraftSectionSchema).default([]),
  conclusion: z.array(z.string()).default([]),
  footnotes: z.array(DraftFootnoteSchema).default([]),
  worksCited: z.array(z.string()).default([]),
  /** Per-paragraph verbatim evidence anchors, verified server-side. */
  evidence: z.array(EvidenceSchema).default([]),
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
