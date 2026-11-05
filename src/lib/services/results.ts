// Student-facing results. Students can ONLY see released (PUBLISHED)
// submissions — provisional/approved grades are faculty-visible exclusively.
import { prisma } from "../db";
import { ApiError } from "../http";
import { latestGrade } from "./grading";

export interface ReleasedCriterionRow {
  criterionName: string;
  maxMarks: number;
  awardedMarks: number;
  feedback: string;
}

export interface ReleasedBreakdownRow {
  questionId: string;
  order: number;
  type: string;
  question: string;
  maxMarks: number;
  awardedMarks: number;
  selectedOption?: string | null;
  correctOptionText?: string | null;
  criteria?: ReleasedCriterionRow[];
  feedback?: string | null;
  gradedBy?: string | null;
}

export async function listReleasedResults(studentId: string, courseId?: string) {
  const submissions = await prisma.examSubmission.findMany({
    where: {
      studentId,
      status: "PUBLISHED",
      ...(courseId ? { exam: { courseId } } : {}),
    },
    include: {
      exam: {
        select: {
          id: true,
          title: true,
          description: true,
          courseId: true,
          course: { select: { code: true, title: true } },
          questions: { orderBy: { order: "asc" }, select: { id: true, type: true, text: true, marks: true } },
        },
      },
    },
    orderBy: { releasedAt: "desc" },
  });
  return submissions;
}

export async function getReleasedSubmission(studentId: string, submissionId: string) {
  const submission = await prisma.examSubmission.findUnique({
    where: { id: submissionId },
    include: {
      exam: {
        select: {
          id: true,
          courseId: true,
          title: true,
          questions: { orderBy: { order: "asc" } },
        },
      },
      answers: true,
    },
  });
  if (!submission) throw new ApiError(404, "Submission not found");
  if (submission.studentId !== studentId) throw new ApiError(403, "Not your submission");

  // HARD GATE: nothing before release is ever visible to students.
  if (submission.status !== "PUBLISHED" || !submission.releasedAt) {
    throw new ApiError(403, "Results for this exam have not been released yet.");
  }

  const breakdown: ReleasedBreakdownRow[] = [];
  for (const q of submission.exam.questions) {
    const answer = submission.answers.find((a) => a.questionId === q.id);
    if (q.type === "MCQ") {
      const options = q.optionsJson ? (JSON.parse(q.optionsJson) as Array<{ id: string; text: string }>) : [];
      breakdown.push({
        questionId: q.id,
        order: q.order,
        type: q.type,
        question: q.text,
        maxMarks: q.marks,
        awardedMarks: answer?.awardedMarks ?? 0,
        selectedOption: options.find((o) => o.id === answer?.selectedOptionId)?.text ?? null,
        correctOptionText: options.find((o) => o.id === q.correctAnswerId)?.text ?? null,
        gradedBy: answer?.gradedBy ?? null,
      });
    } else {
      const grade = await latestGrade(submissionId, q.id);
      breakdown.push({
        questionId: q.id,
        order: q.order,
        type: q.type,
        question: q.text,
        maxMarks: q.marks,
        awardedMarks: grade?.awardedMarks ?? answer?.awardedMarks ?? 0,
        criteria: (grade?.criteria ?? []).map((c) => ({
          criterionName: c.criterionName,
          maxMarks: c.maxMarks,
          awardedMarks: c.awardedMarks,
          feedback: c.feedback,
        })),
        feedback: grade?.feedback ?? null,
        gradedBy: answer?.gradedBy ?? null,
      });
    }
  }

  return {
    submissionId: submission.id,
    examTitle: submission.exam.title,
    releasedAt: submission.releasedAt,
    mcqMarks: submission.mcqMarks ?? 0,
    writingMarks: submission.writingMarks ?? 0,
    totalMarks: submission.totalMarks ?? 0,
    maxMarks: submission.maxMarks,
    breakdown,
  };
}
