import type { EssayDraft, EssayStructure, SourceItem } from "@/lib/essay-types";
import type { ValidationIssue } from "@/lib/validate";

declare module "docx-preview" {
  export function renderAsync(
    document: Blob | ArrayBuffer | Uint8Array,
    container: HTMLElement,
    styleContainer?: HTMLElement | null,
    options?: Record<string, unknown>,
  ): Promise<void>;
}

export type { EssayDraft, EssayStructure, SourceItem, ValidationIssue };

export type StudioMode = "staged" | "one-shot";

/** Normalised shape of POST /api/draft and POST /api/refine responses. */
export interface DraftResult {
  projectId: string;
  versionId: string;
  version: number;
  draft: EssayDraft;
  wordCount: number;
  footnoteCount: number;
  worksCitedCount: number;
  issues: ValidationIssue[];
  summary: string;
  downloadUrl: string;
}

/** One selectable entry in the preview version dropdown. */
export interface VersionEntry {
  id: string;
  version: number;
  title: string;
  wordCount: number;
  footnoteCount: number;
  worksCitedCount: number;
  summary: string;
  downloadUrl: string;
  /** Null for history entries loaded from /api/projects (blob preview only). */
  draft: EssayDraft | null;
  issues: ValidationIssue[];
}

export interface HistoryVersion {
  id: string;
  version: number;
  title: string;
  wordCount: number;
  footnoteCount: number;
  summary: string;
}

export interface HistoryProject {
  id: string;
  title: string;
  topic: string;
  wordTarget: number;
  updatedAt: string;
  versions: HistoryVersion[];
  _count: { versions: number };
}

export function toVersionEntry(result: DraftResult): VersionEntry {
  return {
    id: result.versionId,
    version: result.version,
    title: result.draft.title || `Version ${result.version}`,
    wordCount: result.wordCount,
    footnoteCount: result.footnoteCount,
    worksCitedCount: result.worksCitedCount,
    summary: result.summary,
    downloadUrl: result.downloadUrl,
    draft: result.draft,
    issues: result.issues,
  };
}

export function formatWords(n: number): string {
  return n.toLocaleString("en-GB");
}
