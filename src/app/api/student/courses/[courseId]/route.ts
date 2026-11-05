import { jsonOk, route } from "@/lib/http";
import { requireStudent } from "@/lib/access";
import { prisma } from "@/lib/db";

/** GET: one course for an enrolled student (published exams, visible materials, own QA + released results). */
export async function GET(_req: Request, { params }: { params: Promise<{ courseId: string }> }) {
  return route(async () => {
    const user = await requireStudent();
    const { courseId } = await params;
    const enrollment = await prisma.enrollment.findUnique({
      where: { courseId_userId: { courseId, userId: user.id } },
      include: { course: true },
    });
    if (!enrollment) return jsonOk({ error: "You are not enrolled in this course" }, 403);
    const courseId_ = courseId;

    const exams = await prisma.exam.findMany({ where: { courseId: courseId_, status: "PUBLISHED" } });
    const materials = await prisma.document.findMany({
      where: { courseId: courseId_, visibleToStudents: true, status: "PROCESSED" },
      select: { id: true, title: true, kind: true, chapter: { select: { title: true } }, createdAt: true },
    });
    const lectures = await prisma.lecture.findMany({ where: { courseId: courseId_ }, orderBy: { lastUpdate: "desc" }, include: { segments: { select: { id: true } } } });
    const qa = await prisma.qaEntry.findMany({ where: { courseId: courseId_, studentId: user.id }, orderBy: { createdAt: "desc" }, take: 20 });
    const mySubmissions = await prisma.examSubmission.findMany({
      where: { studentId: user.id, exam: { courseId: courseId_ } },
      select: { id: true, status: true, exam: { select: { title: true } } },
    });
    const releasedResults = mySubmissions.filter((s) => s.status === "PUBLISHED");

    return jsonOk({
      course: { id: enrollment.course.id, code: enrollment.course.code, title: enrollment.course.title, unit: enrollment.course.unit, professor: enrollment.course.professorId },
      exams,
      materials,
      lectures: lectures.map((l) => ({ id: l.id, title: l.title, dateStr: l.dateStr, status: l.status, segments: l.segments.length })),
      qa,
      submissions: mySubmissions,
      releasedResults,
    });
  });
}
