import { NextRequest } from "next/server";
import { checkOrigin, jsonOk, readJson, route } from "@/lib/http";
import { requireFaculty } from "@/lib/access";
import { overrideWritingMarks, approveQuestion, approveAll, releaseResults, regradeQuestion, latestGrade, recalculateTotals } from "@/lib/services/grading";
import { requireOwnedExam } from "@/lib/access";
import { prisma } from "@/lib/db";

/** GET detail of one submission for the faculty grading dashboard. */
export async function GET(_req: Request, { params }: { params: Promise<{ submissionId: string }> }) {
  return route(async () => {
    const user = await requireFaculty();
    const { submissionId } = await params;
    const submission = await prisma.examSubmission.findUnique({
      where: { id: submissionId },
      include: {
        exam: { include: { course: true, questions: { orderBy: { order: "asc" } } } },
        student: { select: { id: true, name: true, email: true } },
        answers: true,
        audits: { orderBy: { createdAt: "desc" }, take: 200 },
      },
    });
    if (!submission) return jsonOk({ error: "Submission not found" }, 404);
    await requireOwnedExam(submission.examId, user);

    const questions = [];
    for (const q of submission.exam.questions) {
      const answer = submission.answers.find((a) => a.questionId === q.id) ?? null;
      const grade = q.type === "WRITING" ? await latestGrade(submissionId, q.id) : null;
      const rubric = q.type === "WRITING" ? await prisma.rubric.findUnique({ where: { id: grade?.rubricId ?? "" }, include: { criteria: { orderBy: { order: "asc" } } } }) : null;
      questions.push({ question: q, answer, grade, rubric });
    }
    return jsonOk({
      submission: {
        id: submission.id,
        status: submission.status,
        student: submission.student,
        mcqMarks: submission.mcqMarks,
        writingMarks: submission.writingMarks,
        totalMarks: submission.totalMarks,
        maxMarks: submission.maxMarks,
        exam: { id: submission.exam.id, title: submission.exam.title, instructions: submission.exam.instructions, courseTitle: submission.exam.course.title },
        submittedAt: submission.submittedAt,
      },
      questions,
      audits: submission.audits,
    });
  });
}

/** POST faculty review actions (all audited):
 * { action: "override", questionId, criterionMarks: [{criterionId, awardedMarks}], feedback?, reason }
 * { action: "approve_question" | "regrade", questionId, reason? }
 * { action: "approve_all" | "release", reason? }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ submissionId: string }> }) {
  return route(async () => {
    checkOrigin(req);
    const user = await requireFaculty();
    const { submissionId } = await params;
    const submission = await prisma.examSubmission.findUnique({ where: { id: submissionId }, select: { examId: true } });
    if (!submission) return jsonOk({ error: "Submission not found" }, 404);
    await requireOwnedExam(submission.examId, user);

    const body = await readJson<Record<string, unknown>>(req);
    const reason = typeof body.reason === "string" && body.reason ? body.reason : null;

    switch (body.action) {
      case "override": {
        const out = await overrideWritingMarks(
          submissionId,
          String(body.questionId),
          user.id,
          (body.criterionMarks as Array<{ criterionId: string; awardedMarks: number }>) ?? [],
          body.feedback === null ? null : String(body.feedback ?? ""),
          String(body.reason ?? "faculty override")
        );
        return jsonOk(out);
      }
      case "approve_question":
        return jsonOk(await approveQuestion(submissionId, String(body.questionId), user.id, reason));
      case "regrade":
        return jsonOk(await regradeQuestion(submissionId, String(body.questionId), user.id, reason));
      case "approve_all":
        return jsonOk(await approveAll(submissionId, user.id, reason));
      case "release":
        return jsonOk(await releaseResults(submissionId, user.id, reason));
      case "recalculate":
        return jsonOk({ submission: await recalculateTotals(submissionId) });
      default:
        return jsonOk({ error: `Unknown review action "${body.action}"` }, 400);
    }
  });
}
