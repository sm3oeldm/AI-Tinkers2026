import { NextRequest } from "next/server";
import { checkOrigin, jsonOk, readJson, route } from "@/lib/http";
import { requireCourseOwner, requireFaculty } from "@/lib/access";
import { prisma } from "@/lib/db";

export async function POST(req: NextRequest, { params }: { params: Promise<{ courseId: string }> }) {
  return route(async () => {
    checkOrigin(req);
    const user = await requireFaculty();
    const { courseId } = await params;
    await requireCourseOwner(courseId, user);
    const body = await readJson<{ title?: string }>(req);
    if (!body.title?.trim()) return jsonOk({ error: "Chapter title required" }, 400);
    const count = await prisma.chapter.count({ where: { courseId } });
    const chapter = await prisma.chapter.create({
      data: { courseId, title: body.title.trim(), shortId: `ch${count + 1}`, order: count + 1 },
    });
    return jsonOk({ chapter }, 201);
  });
}
