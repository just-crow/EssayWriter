-- Supabase Database Schema for EssayWriter

-- Create Project table
CREATE TABLE IF NOT EXISTS "Project" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "title" TEXT NOT NULL DEFAULT 'Untitled essay',
  "topic" TEXT NOT NULL DEFAULT '',
  "instruction" TEXT NOT NULL DEFAULT '',
  "wordTarget" INTEGER NOT NULL DEFAULT 1200,
  "mode" TEXT NOT NULL DEFAULT 'staged',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create EssayVersion table
CREATE TABLE IF NOT EXISTS "EssayVersion" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "version" INTEGER NOT NULL DEFAULT 1,
  "title" TEXT NOT NULL DEFAULT '',
  "essayJson" TEXT NOT NULL DEFAULT '{}',
  "docxPath" TEXT NOT NULL DEFAULT '',
  "wordCount" INTEGER NOT NULL DEFAULT 0,
  "footnoteCount" INTEGER NOT NULL DEFAULT 0,
  "summary" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "EssayVersion_projectId_idx" ON "EssayVersion"("projectId");

-- Create Source table
CREATE TABLE IF NOT EXISTS "Source" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "author" TEXT NOT NULL DEFAULT '',
  "title" TEXT NOT NULL DEFAULT '',
  "publisher" TEXT NOT NULL DEFAULT '',
  "year" TEXT NOT NULL DEFAULT '',
  "url" TEXT NOT NULL DEFAULT '',
  "accessed" TEXT NOT NULL DEFAULT '',
  "supports" TEXT NOT NULL DEFAULT '',
  "content" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "Source_projectId_idx" ON "Source"("projectId");

-- Create ChatMessage table
CREATE TABLE IF NOT EXISTS "ChatMessage" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL DEFAULT 'user',
  "content" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ChatMessage_projectId_idx" ON "ChatMessage"("projectId");
