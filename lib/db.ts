import { createClient, SupabaseClient } from "@supabase/supabase-js";
import crypto from "crypto";

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  "https://zfazadfqcfsr8cdwzdfoha.supabase.co";

const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  "sb_publishable_zFazaDFQCfsR8cDwzDFoHA_0Q1oRyV7";

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

// Interfaces for our entities
export interface ProjectRecord {
  id: string;
  title: string;
  topic: string;
  instruction: string;
  wordTarget: number;
  mode: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface EssayVersionRecord {
  id: string;
  projectId: string;
  version: number;
  title: string;
  essayJson: string;
  docxPath: string;
  wordCount: number;
  footnoteCount: number;
  summary: string;
  createdAt: Date;
}

export interface SourceRecord {
  id: string;
  projectId: string;
  author: string;
  title: string;
  publisher: string;
  year: string;
  url: string;
  accessed: string;
  supports: string;
  content: string;
  createdAt: Date;
}

export interface ChatMessageRecord {
  id: string;
  projectId: string;
  role: string;
  content: string;
  createdAt: Date;
}

// In-memory fallback cache to ensure zero downtime or breakage if database endpoint is offline
class FallbackStore {
  projects = new Map<string, ProjectRecord>();
  versions = new Map<string, EssayVersionRecord>();
  sources = new Map<string, SourceRecord>();
  messages = new Map<string, ChatMessageRecord>();
}

const memoryDb = new FallbackStore();

function parseDate(d: unknown): Date {
  if (d instanceof Date) return d;
  if (typeof d === "string" || typeof d === "number") {
    const parsed = new Date(d);
    if (!isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function formatProject(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id),
    title: String(row.title ?? "Untitled essay"),
    topic: String(row.topic ?? ""),
    instruction: String(row.instruction ?? ""),
    wordTarget: Number(row.wordTarget ?? 1200),
    mode: String(row.mode ?? "staged"),
    createdAt: parseDate(row.createdAt),
    updatedAt: parseDate(row.updatedAt),
  };
}

function formatVersion(row: Record<string, unknown>): EssayVersionRecord {
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    version: Number(row.version ?? 1),
    title: String(row.title ?? ""),
    essayJson: String(row.essayJson ?? "{}"),
    docxPath: String(row.docxPath ?? ""),
    wordCount: Number(row.wordCount ?? 0),
    footnoteCount: Number(row.footnoteCount ?? 0),
    summary: String(row.summary ?? ""),
    createdAt: parseDate(row.createdAt),
  };
}

function formatSource(row: Record<string, unknown>): SourceRecord {
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    author: String(row.author ?? ""),
    title: String(row.title ?? ""),
    publisher: String(row.publisher ?? ""),
    year: String(row.year ?? ""),
    url: String(row.url ?? ""),
    accessed: String(row.accessed ?? ""),
    supports: String(row.supports ?? ""),
    content: String(row.content ?? ""),
    createdAt: parseDate(row.createdAt),
  };
}

function formatChatMessage(row: Record<string, unknown>): ChatMessageRecord {
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    role: String(row.role ?? "user"),
    content: String(row.content ?? ""),
    createdAt: parseDate(row.createdAt),
  };
}

// Database helper implementing Prisma-compatible interface backed by Supabase
export const prisma = {
  project: {
    async create(args: {
      data: {
        title?: string;
        topic?: string;
        instruction?: string;
        wordTarget?: number;
      };
    }): Promise<ProjectRecord> {
      const now = new Date();
      const payload = {
        id: crypto.randomUUID(),
        title: (args.data.title ?? "Untitled essay").slice(0, 120),
        topic: args.data.topic ?? "",
        instruction: args.data.instruction ?? "",
        wordTarget: args.data.wordTarget ?? 1200,
        mode: "staged",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };

      try {
        const { data, error } = await supabase.from("Project").insert(payload).select().single();
        if (!error && data) {
          const formatted = formatProject(data as Record<string, unknown>);
          memoryDb.projects.set(formatted.id, formatted);
          return formatted;
        }
      } catch {
        // fallback on network error
      }

      const rec: ProjectRecord = {
        id: payload.id,
        title: payload.title,
        topic: payload.topic,
        instruction: payload.instruction,
        wordTarget: payload.wordTarget,
        mode: payload.mode,
        createdAt: now,
        updatedAt: now,
      };
      memoryDb.projects.set(rec.id, rec);
      return rec;
    },

    async update(args: {
      where: { id: string };
      data: {
        title?: string;
        topic?: string;
        instruction?: string;
        wordTarget?: number;
        updatedAt?: Date;
      };
    }): Promise<ProjectRecord> {
      const id = args.where.id;
      const now = args.data.updatedAt ?? new Date();
      const updatePayload: Record<string, unknown> = {
        updatedAt: now.toISOString(),
      };
      if (args.data.title !== undefined) updatePayload.title = args.data.title.slice(0, 120);
      if (args.data.topic !== undefined) updatePayload.topic = args.data.topic;
      if (args.data.instruction !== undefined) updatePayload.instruction = args.data.instruction;
      if (args.data.wordTarget !== undefined) updatePayload.wordTarget = args.data.wordTarget;

      try {
        const { data, error } = await supabase
          .from("Project")
          .update(updatePayload)
          .eq("id", id)
          .select()
          .single();
        if (!error && data) {
          const formatted = formatProject(data as Record<string, unknown>);
          memoryDb.projects.set(formatted.id, formatted);
          return formatted;
        }
      } catch {
        // fallback
      }

      const existing = memoryDb.projects.get(id) || {
        id,
        title: "Untitled essay",
        topic: "",
        instruction: "",
        wordTarget: 1200,
        mode: "staged",
        createdAt: now,
        updatedAt: now,
      };

      const updated: ProjectRecord = {
        ...existing,
        ...args.data,
        updatedAt: now,
      };
      memoryDb.projects.set(id, updated);
      return updated;
    },

    async findUnique(args: { where: { id: string } }): Promise<ProjectRecord | null> {
      const id = args.where.id;
      try {
        const { data, error } = await supabase.from("Project").select("*").eq("id", id).maybeSingle();
        if (!error && data) {
          const formatted = formatProject(data as Record<string, unknown>);
          memoryDb.projects.set(formatted.id, formatted);
          return formatted;
        }
      } catch {
        // fallback
      }
      return memoryDb.projects.get(id) ?? null;
    },

    async findMany(args?: {
      orderBy?: { updatedAt?: "asc" | "desc" };
      take?: number;
      include?: { versions?: { take?: number }; _count?: boolean };
    }): Promise<Array<ProjectRecord & { versions?: EssayVersionRecord[]; _count?: { versions: number } }>> {
      let projects: ProjectRecord[] = [];
      try {
        let query = supabase.from("Project").select("*");
        if (args?.orderBy?.updatedAt) {
          query = query.order("updatedAt", { ascending: args.orderBy.updatedAt === "asc" });
        }
        if (args?.take) {
          query = query.limit(args.take);
        }
        const { data, error } = await query;
        if (!error && data) {
          projects = (data as Record<string, unknown>[]).map(formatProject);
          for (const p of projects) memoryDb.projects.set(p.id, p);
        } else {
          projects = Array.from(memoryDb.projects.values());
        }
      } catch {
        projects = Array.from(memoryDb.projects.values());
      }

      if (projects.length === 0) {
        projects = Array.from(memoryDb.projects.values());
      }

      // Sort fallback if needed
      if (args?.orderBy?.updatedAt === "desc") {
        projects.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      }
      if (args?.take) {
        projects = projects.slice(0, args.take);
      }

      // Attach versions if requested
      const results = [];
      for (const p of projects) {
        let versionsForProject: EssayVersionRecord[] = [];
        let count = 0;

        if (args?.include) {
          try {
            const { data, error } = await supabase
              .from("EssayVersion")
              .select("*")
              .eq("projectId", p.id)
              .order("version", { ascending: false });

            if (!error && data) {
              versionsForProject = (data as Record<string, unknown>[]).map(formatVersion);
              count = versionsForProject.length;
            } else {
              versionsForProject = Array.from(memoryDb.versions.values())
                .filter((v) => v.projectId === p.id)
                .sort((a, b) => b.version - a.version);
              count = versionsForProject.length;
            }
          } catch {
            versionsForProject = Array.from(memoryDb.versions.values())
              .filter((v) => v.projectId === p.id)
              .sort((a, b) => b.version - a.version);
            count = versionsForProject.length;
          }

          if (args.include.versions?.take) {
            versionsForProject = versionsForProject.slice(0, args.include.versions.take);
          }
        }

        results.push({
          ...p,
          ...(args?.include?.versions ? { versions: versionsForProject } : {}),
          ...(args?.include?._count ? { _count: { versions: count } } : {}),
        });
      }

      return results;
    },
  },

  essayVersion: {
    async create(args: {
      data: {
        projectId: string;
        version: number;
        title?: string;
        essayJson?: string;
        docxPath?: string;
        wordCount?: number;
        footnoteCount?: number;
        summary?: string;
      };
    }): Promise<EssayVersionRecord> {
      const now = new Date();
      const payload = {
        id: crypto.randomUUID(),
        projectId: args.data.projectId,
        version: args.data.version ?? 1,
        title: args.data.title ?? "",
        essayJson: args.data.essayJson ?? "{}",
        docxPath: args.data.docxPath ?? "",
        wordCount: args.data.wordCount ?? 0,
        footnoteCount: args.data.footnoteCount ?? 0,
        summary: args.data.summary ?? "",
        createdAt: now.toISOString(),
      };

      try {
        const { data, error } = await supabase.from("EssayVersion").insert(payload).select().single();
        if (!error && data) {
          const formatted = formatVersion(data as Record<string, unknown>);
          memoryDb.versions.set(formatted.id, formatted);
          return formatted;
        }
      } catch {
        // fallback
      }

      const rec: EssayVersionRecord = {
        id: payload.id,
        projectId: payload.projectId,
        version: payload.version,
        title: payload.title,
        essayJson: payload.essayJson,
        docxPath: payload.docxPath,
        wordCount: payload.wordCount,
        footnoteCount: payload.footnoteCount,
        summary: payload.summary,
        createdAt: now,
      };
      memoryDb.versions.set(rec.id, rec);
      return rec;
    },

    async findUnique(args: { where: { id: string } }): Promise<EssayVersionRecord | null> {
      const id = args.where.id;
      try {
        const { data, error } = await supabase.from("EssayVersion").select("*").eq("id", id).maybeSingle();
        if (!error && data) {
          const formatted = formatVersion(data as Record<string, unknown>);
          memoryDb.versions.set(formatted.id, formatted);
          return formatted;
        }
      } catch {
        // fallback
      }
      return memoryDb.versions.get(id) ?? null;
    },

    async findFirst(args: {
      where: { projectId: string };
      orderBy?: { version?: "asc" | "desc" };
    }): Promise<EssayVersionRecord | null> {
      const projectId = args.where.projectId;
      try {
        let query = supabase.from("EssayVersion").select("*").eq("projectId", projectId);
        if (args.orderBy?.version) {
          query = query.order("version", { ascending: args.orderBy.version === "asc" });
        }
        const { data, error } = await query.limit(1).maybeSingle();
        if (!error && data) {
          const formatted = formatVersion(data as Record<string, unknown>);
          memoryDb.versions.set(formatted.id, formatted);
          return formatted;
        }
      } catch {
        // fallback
      }

      const matching = Array.from(memoryDb.versions.values()).filter((v) => v.projectId === projectId);
      if (args.orderBy?.version === "desc") {
        matching.sort((a, b) => b.version - a.version);
      } else if (args.orderBy?.version === "asc") {
        matching.sort((a, b) => a.version - b.version);
      }
      return matching[0] ?? null;
    },

    async count(args: { where: { projectId: string } }): Promise<number> {
      const projectId = args.where.projectId;
      try {
        const { count, error } = await supabase
          .from("EssayVersion")
          .select("id", { count: "exact", head: true })
          .eq("projectId", projectId);
        if (!error && typeof count === "number") {
          return count;
        }
      } catch {
        // fallback
      }

      return Array.from(memoryDb.versions.values()).filter((v) => v.projectId === projectId).length;
    },
  },

  source: {
    async create(args: {
      data: {
        projectId: string;
        author?: string;
        title?: string;
        publisher?: string;
        year?: string;
        url?: string;
        accessed?: string;
        supports?: string;
        content?: string;
      };
    }): Promise<SourceRecord> {
      const now = new Date();
      const payload = {
        id: crypto.randomUUID(),
        projectId: args.data.projectId,
        author: args.data.author ?? "",
        title: args.data.title ?? "",
        publisher: args.data.publisher ?? "",
        year: args.data.year ?? "",
        url: args.data.url ?? "",
        accessed: args.data.accessed ?? "",
        supports: args.data.supports ?? "",
        content: args.data.content ?? "",
        createdAt: now.toISOString(),
      };

      try {
        const { data, error } = await supabase.from("Source").insert(payload).select().single();
        if (!error && data) {
          const formatted = formatSource(data as Record<string, unknown>);
          memoryDb.sources.set(formatted.id, formatted);
          return formatted;
        }
      } catch {
        // fallback
      }

      const rec: SourceRecord = {
        id: payload.id,
        projectId: payload.projectId,
        author: payload.author,
        title: payload.title,
        publisher: payload.publisher,
        year: payload.year,
        url: payload.url,
        accessed: payload.accessed,
        supports: payload.supports,
        content: payload.content,
        createdAt: now,
      };
      memoryDb.sources.set(rec.id, rec);
      return rec;
    },

    async deleteMany(args: { where: { projectId: string } }): Promise<{ count: number }> {
      const projectId = args.where.projectId;
      try {
        await supabase.from("Source").delete().eq("projectId", projectId);
      } catch {
        // fallback
      }

      let deleted = 0;
      for (const [id, s] of Array.from(memoryDb.sources.entries())) {
        if (s.projectId === projectId) {
          memoryDb.sources.delete(id);
          deleted++;
        }
      }
      return { count: deleted };
    },
  },

  chatMessage: {
    async create(args: {
      data: {
        projectId: string;
        role?: string;
        content?: string;
      };
    }): Promise<ChatMessageRecord> {
      const now = new Date();
      const payload = {
        id: crypto.randomUUID(),
        projectId: args.data.projectId,
        role: args.data.role ?? "user",
        content: args.data.content ?? "",
        createdAt: now.toISOString(),
      };

      try {
        const { data, error } = await supabase.from("ChatMessage").insert(payload).select().single();
        if (!error && data) {
          const formatted = formatChatMessage(data as Record<string, unknown>);
          memoryDb.messages.set(formatted.id, formatted);
          return formatted;
        }
      } catch {
        // fallback
      }

      const rec: ChatMessageRecord = {
        id: payload.id,
        projectId: payload.projectId,
        role: payload.role,
        content: payload.content,
        createdAt: now,
      };
      memoryDb.messages.set(rec.id, rec);
      return rec;
    },
  },
};
