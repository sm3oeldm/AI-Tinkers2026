import { jsonOk, route } from "@/lib/http";
import { requireOwnedExam, requireFaculty } from "@/lib/access";
import { prisma } from "@/lib/db";
import { latestGrade } from "@/lib/services/grading";

/** GET: all submissions for this exam with per-question breakdown (faculty). */
export async function GET(_req: Request, { params }: { params: Promise<{ examId: string }> }) {
  return route(async () => {
    const user = await requireFaculty();
    const { examId } = await params;
    await requireOwnedExam(examId, user);

    const exam = await prisma.exam.findUnique({
      where: { id: examId },
      include: {
        questions: { orderBy: { order: "asc" } },
        submissions: { include: { student: { select: { id: true, name: true, email: true } } }, orderBy: { submittedAt: "desc" } },
      },
    });
    if (!exam) return jsonOk({ error: "Exam not found" }, 404);

    const submissions = [];
    for (const s of exam.submissions) {
      const questions = [];
      for (const q of exam.questions) {
        const answer = (await prisma.answer.findUnique({ where: { submissionId_questionId: { submissionId: s.id, questionId: q.id } } })) ?? null;
        const grade = q.type === "WRITING" ? await latestGrade(s.id, q.id) : null;
        questions.push({
          questionId: q.id,
          order: q.order,
          type: q.type,
          text: q.text,
          maxMarks: q.marks,
          awardedMarks: grade?.awardedMarks ?? answer?.awardedMarks ?? null,
          gradedBy: grade ? (s.status === "PUBLISHED" ? answer?.gradedBy : "AI") : answer?.gradedBy,
          status: grade?.status ?? null,
          flagged: (grade?.criteria ?? []).some((c) => c.flagged),
        });
      }
      submissions.push({
        id: s.id,
        student: s.student,
        status: s.status,
        submittedAt: s.submittedAt,
        mcqMarks: s.mcqMarks,
        writingMarks: s.writingMarks,
        totalMarks: s.totalMarks,
        maxMarks: s.maxMarks,
        questions,
      });
    }
    return jsonOk({ exam: { id: exam.id, title: exam.title, status: exam.status, questions: exam.questions }, submissions });
  });
}
