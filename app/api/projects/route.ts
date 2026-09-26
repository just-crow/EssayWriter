import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: Request) {
  // Privacy: history is scoped to project IDs this browser created
  // (stored in its localStorage). No ids -> empty list, never everyone's.
  const ids =
    new URL(req.url).searchParams
      .get("ids")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100) ?? [];
  if (ids.length === 0) return NextResponse.json({ projects: [] });
  const projects = await prisma.project.findMany({
    where: { id: { in: ids } },
    orderBy: { updatedAt: "desc" },
    take: 50,
    include: {
      versions: { orderBy: { version: "desc" }, take: 1 },
      _count: { select: { versions: true } },
    },
  });
  return NextResponse.json({ projects });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { title?: string };
  const project = await prisma.project.create({
    data: { title: (body.title ?? "Untitled essay").slice(0, 120) },
  });
  return NextResponse.json({ project });
}
