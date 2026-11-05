import { jsonOk, route } from "@/lib/http";
import { requireStudent } from "@/lib/access";
import { prisma } from "@/lib/db";

/** GET: the student's courses + published exams + released-result counts. */
export async function GET() {
  return route(async () => {
    const user = await requireStudent();
    const enrollments = await prisma.enrollment.findMany({
      where: { userId: user.id },
      include: {
        course: {
          include: {
            exams: { where: { status: "PUBLISHED" }, select: { id: true, title: true, durationMinutes: true, publishedAt: true } },
            professor: { select: { name: true } },
          },
        },
      },
    });
    const courses = [];
    for (const e of enrollments) {
      const released = await prisma.examSubmission.count({ where: { studentId: user.id, status: "PUBLISHED", exam: { courseId: e.courseId } } });
      courses.push({ ...e.course, releasedResults: released });
    }
    return jsonOk({ courses });
  });
}
