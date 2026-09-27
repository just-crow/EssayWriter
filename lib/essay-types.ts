import { z } from "zod";

export const StructureParagraphSchema = z.object({
  point: z.string(),
  criterion: z.string().default(""),
  strand: z.string().default(""),
});

export const StructureSectionSchema = z.object({
  heading: z.string(),
  // Bullet count is the model's choice; usually 2 to 4 per section.
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
  id: z.number().int().min(1),
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
/** Models sometimes return one paragraph as an array of sentences, or
 * a single introduction as a string. Preserve prose and paragraph boundaries
 * while normalizing these equivalent representations before validation. */
function normalizeWriterShape(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const draft = input as Record<string, unknown>;
  const text = (value: unknown): unknown => Array.isArray(value) && value.every((part) => typeof part === "string") ? value.join(" ") : value;
  const paragraphs = (value: unknown): unknown => typeof value === "string" ? [value] : Array.isArray(value) ? value.map(text) : value;
  const single = (value: unknown): unknown => {
    const normalized = paragraphs(value);
    return Array.isArray(normalized) && normalized.every((part) => typeof part === "string") ? [normalized.join(" ")] : normalized;
  };
  return {
    ...draft,
    introduction: single(draft.introduction),
    conclusion: single(draft.conclusion),
    sections: Array.isArray(draft.sections) ? draft.sections.map((section) => {
      if (!section || typeof section !== "object" || Array.isArray(section)) return section;
      return { ...section, paragraphs: paragraphs(section.paragraphs) };
    }) : draft.sections,
  };
}
// Evidence anchors are produced by the server's source verifier, not by
// asking the writer to copy quotations or reproduce a second numbering scheme.
export const WriterDraftSchema = z.preprocess(normalizeWriterShape, DraftSchema.extend({ evidence: z.unknown().optional() })
  .transform((draft) => ({ ...draft, evidence: [] as z.infer<typeof EvidenceSchema>[] })));

/** Validate representation here. Length and depth apply to verified prose. */
export function writerDraftSchema() {
  // NIM's constrained decoder treats patterns as a whole-string grammar.
  // Allow prose around the marker rather than decoding a marker alone.
  // Exclude raw JSON delimiters: this decoder applies the regex before
  // string escaping, so an unrestricted wildcard can consume closing quotes.
  const cited = z.string().regex(/[^"\\\r\n]*\[\^[1-9]\d*\][^"\\\r\n]*/, "Use a cited prose paragraph without double quotes or line breaks.");
  return z.preprocess(normalizeWriterShape, DraftSchema.extend({
    introduction: z.array(cited.min(1)).length(1),
    conclusion: z.array(cited.min(1)).length(1),
    sections: z.array(DraftSectionSchema.extend({
      // Final paragraph depth is checked after source verification and
      // consolidation, rather than rejecting a raw paragraph before merging.
      paragraphs: z.array(cited.min(1)).min(1),
    })).min(1),
    evidence: z.unknown().optional(),
    footnotes: z.unknown().optional(),
    worksCited: z.unknown().optional(),
  }).transform((draft) => ({ ...draft, footnotes: [] as z.infer<typeof DraftFootnoteSchema>[], worksCited: [] as string[], evidence: [] as z.infer<typeof EvidenceSchema>[] })));
}
export type SourceItem = z.infer<typeof SourceItemSchema>;
export type EssayDraft = z.infer<typeof DraftSchema>;
