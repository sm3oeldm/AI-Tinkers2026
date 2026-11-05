import { NextRequest } from "next/server";
import { checkOrigin, jsonOk, readJson, route } from "@/lib/http";
import { requireCourseOwner, requireFaculty } from "@/lib/access";
import { prisma } from "@/lib/db";

/** Faculty: POST start lecture {title,dateStr}; PUT /save segment {text}; PATCH archive. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ courseId: string }> }) {
  return route(async () => {
    checkOrigin(req);
    const user = await requireFaculty();
    const { courseId } = await params;
    await requireCourseOwner(courseId, user);
    const body = await readJson<{ action?: string; title?: string; dateStr?: string; lectureId?: string; text?: string }>(req);

    switch (body.action) {
      case "start": {
        const dateStr = body.dateStr || new Date().toISOString().slice(0, 10);
        const lecture = await prisma.lecture.create({
          data: { courseId, title: body.title?.trim() || "Untitled lecture", dateStr, status: "LIVE" },
        });
        return jsonOk({ lecture }, 201);
      }
      case "segment": {
        if (!body.lectureId) return jsonOk({ error: "lectureId required" }, 400);
        const lecture = await prisma.lecture.findUnique({ where: { id: body.lectureId } });
        if (!lecture || lecture.courseId !== courseId) return jsonOk({ error: "Lecture not found" }, 404);
        const seq = lecture.seq + 1;
        const [updated, segment] = await prisma.$transaction([
          prisma.lecture.update({ where: { id: lecture.id }, data: { seq, lastUpdate: new Date() } }),
          prisma.transcriptSegment.create({ data: { lectureId: lecture.id, seq, offset: "", text: body.text ?? "" } }),
        ]);
        void updated;
        return jsonOk({ segment }, 201);
      }
      case "archive": {
        if (!body.lectureId) return jsonOk({ error: "lectureId required" }, 400);
        const lecture = await prisma.lecture.update({ where: { id: body.lectureId }, data: { status: "ARCHIVED" } });
        return jsonOk({ lecture });
      }
      default:
        return jsonOk({ error: `Unknown lecture action "${body.action}"` }, 400);
    }
  });
}

/** GET: lecture archive with transcripts. */
export async function GET(_req: Request, { params }: { params: Promise<{ courseId: string }> }) {
  return route(async () => {
    const { courseId } = await params;
    const lectures = await prisma.lecture.findMany({
      where: { courseId },
      orderBy: { lastUpdate: "desc" },
      include: { segments: { orderBy: { seq: "asc" } } },
    });
    return jsonOk({ lectures });
  });
}
