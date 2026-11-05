import { jsonOk, route } from "@/lib/http";
import { requireCourseOwner, requireFaculty } from "@/lib/access";
import { prisma } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ courseId: string }> }) {
  return route(async () => {
    const user = await requireFaculty();
    const { courseId } = await params;
    await requireCourseOwner(courseId, user);
    const course = await prisma.course.findUnique({
      where: { id: courseId },
      include: {
        chapters: { orderBy: { order: "asc" } },
        documents: { orderBy: { createdAt: "asc" }, include: { chapter: true } },
        exams: { orderBy: { createdAt: "desc" }, select: { id: true, title: true, status: true, createdAt: true, durationMinutes: true, isAiGenerated: true, generationMeta: true, _count: { select: { questions: true, submissions: true } } } },
        lectures: { orderBy: { lastUpdate: "desc" } },
      },
    });
    if (!course) return jsonOk({ error: "Course not found" }, 404);
    const enrollments = await prisma.enrollment.findMany({ where: { courseId }, include: { user: { select: { id: true, name: true, email: true } } } });
    return jsonOk({ course, students: enrollments.map((e) => e.user) });
  });
}
