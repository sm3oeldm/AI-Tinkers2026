import { NextRequest } from "next/server";
import { checkOrigin, jsonOk, readJson, route } from "@/lib/http";
import { requireFaculty } from "@/lib/access";
import { prisma } from "@/lib/db";

export async function GET() {
  return route(async () => {
    const user = await requireFaculty();
    const courses = await prisma.course.findMany({
      where: { professorId: user.id },
      include: { _count: { select: { exams: true, documents: true, enrollments: true } } },
      orderBy: { createdAt: "asc" },
    });
    return jsonOk({ courses });
  });
}

export async function POST(req: NextRequest) {
  return route(async () => {
    checkOrigin(req);
    const user = await requireFaculty();
    const body = await readJson<{ code?: string; title?: string; unit?: string; description?: string; chapterTitles?: string[] }>(req);
    if (!body.code || !body.title) return jsonOk({ error: "code and title are required" }, 400);
    const course = await prisma.course.create({
      data: { code: body.code, title: body.title, unit: body.unit ?? null, description: body.description ?? null, professorId: user.id },
    });
    const titles = body.chapterTitles?.filter(Boolean) ?? [];
    for (let i = 0; i < titles.length; i++) {
      await prisma.chapter.create({ data: { courseId: course.id, title: titles[i], shortId: `ch${i + 1}`, order: i + 1 } });
    }
    return jsonOk({ course }, 201);
  });
}
