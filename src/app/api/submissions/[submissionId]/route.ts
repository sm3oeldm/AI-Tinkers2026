import { jsonOk, route } from "@/lib/http";
import { requireStudent } from "@/lib/access";
import { prisma } from "@/lib/db";

/** GET own submission state: if released → full breakdown; else exam runner payload. */
export async function GET(_req: Request, { params }: { params: Promise<{ submissionId: string }> }) {
  return route(async () => {
    const user = await requireStudent();
    const { submissionId } = await params;
    const submission = await prisma.examSubmission.findUnique({
      where: { id: submissionId },
      include: {
        exam: { include: { questions: { orderBy: { order: "asc" } }, course: { select: { title: true, code: true } } } },
        answers: true,
      },
    });
    if (!submission) return jsonOk({ error: "Submission not found" }, 404);
    if (submission.studentId !== user.id) return jsonOk({ error: "Not your submission" }, 403);

    if (submission.status === "PUBLISHED") {
      const { getReleasedSubmission } = await import("@/lib/services/results");
      return jsonOk({ submission: await getReleasedSubmission(user.id, submissionId) });
    }

    // Offered only while taking the exam: exam questions + own in-progress answers.
    return jsonOk({
      submission: {
        id: submission.id,
        status: submission.status,
        examTitle: submission.exam.title,
        courseTitle: submission.exam.course.title,
        available: submission.exam.status === "PUBLISHED",
        durationMinutes: submission.exam.durationMinutes,
        questions: submission.exam.questions.map((q) => ({
          id: q.id,
          order: q.order,
          type: q.type,
          text: q.text,
          marks: q.marks,
          optionsJson: q.optionsJson,
        })),
        answers: submission.answers.map((a) => ({ questionId: a.questionId, selectedOptionId: a.selectedOptionId, text: a.text })),
        // Provisional/hidden grades are NEVER exposed here.
        totalMarks: null,
      },
    });
  });
}
