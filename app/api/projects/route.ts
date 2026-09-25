import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const projects = await prisma.project.findMany({
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
