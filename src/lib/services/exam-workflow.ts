// Draft exam lifecycle: edit → validate → approve (freezes rubric versions) →
// publish (visible to students / submittable). Approval gates are enforced in
// code so no writing question can exist without a valid approved rubric.

import { prisma } from "../db";
import { ApiError } from "../http";
import { RubricPatch, rubricPatchSchema } from "../validation";

export async function getFullExam(examId: string) {
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: {
      course: { select: { id: true, code: true, title: true, professorId: true } },
      questions: { orderBy: { order: "asc" }, include: { rubricVersions: { orderBy: { version: "desc" }, include: { criteria: { orderBy: { order: "asc" } } } } } },
    },
  });
  return exam;
}

export async function requireDraft(examId: string) {
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) throw new ApiError(404, "Exam not found");
  if (exam.status !== "DRAFT" && exam.status !== "GENERATING") {
    throw new ApiError(409, `Exam is ${exam.status}; only drafts can be edited.`);
  }
  return exam;
}

export async function updateExamMeta(examId: string, patch: Partial<{ title: string; description: string | null; instructions: string | null; durationMinutes: number; difficulty: string | null }>) {
  await requireDraft(examId);
  return prisma.exam.update({ where: { id: examId }, data: patch });
}

export function criterionSum(rubric: { criteria: Array<{ maxMarks: number }> }): number {
  return rubric.criteria.reduce((a, c) => a + c.maxMarks, 0);
}

/** Full approval gate (spec 2.4 / 2.5): every writing question must have a
 * rubric whose criterion marks sum EXACTLY to the question's marks, every MCQ
 * must have a valid answer key, and question marks must total the exam marks. */
export async function validateExamForApproval(examId: string) {
  const exam = await getFullExam(examId);
  if (!exam) throw new ApiError(404, "Exam not found");
  const issues: string[] = [];

  let total = 0;
  for (const q of exam.questions) {
    total += q.marks;
    if (q.type === "MCQ") {
      const options = q.optionsJson ? (JSON.parse(q.optionsJson) as Array<{ id: string }>) : [];
      if (options.length < 2) issues.push(`Question ${q.order}: an MCQ needs at least two options.`);
      if (!q.correctAnswerId || !options.some((o) => o.id === q.correctAnswerId)) {
        issues.push(`Question ${q.order}: the MCQ answer key does not match any option.`);
      }
    } else {
      const latest = q.rubricVersions[0];
      if (!latest) {
        issues.push(`Question ${q.order}: missing writing-question rubric.`);
      } else {
        const sum = criterionSum(latest);
        if (latest.criteria.length === 0) issues.push(`Question ${q.order}: rubric has no criteria.`);
        if (Math.abs(sum - q.marks) > 1e-9) {
          issues.push(`Question ${q.order}: rubric criterion marks (${sum}) must equal the question marks (${q.marks}).`);
        }
        for (const c of latest.criteria) {
          if (!(c.maxMarks > 0)) issues.push(`Question ${q.order}: criterion "${c.name}" must have positive marks.`);
          if (!c.fullCredit?.trim()) issues.push(`Question ${q.order}: criterion "${c.name}" is missing full-credit requirements.`);
        }
      }
    }
  }

  return { ok: issues.length === 0, issues, questionCount: exam.questions.length, totalMarks: total };
}

export async function approveExam(examId: string, facultyId: string) {
  await requireDraft(examId);
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { courseId: true } });
  if (!exam) throw new ApiError(404, "Exam not found");
  const course = await prisma.course.findUnique({ where: { id: exam.courseId }, select: { professorId: true } });
  if (course?.professorId !== facultyId) throw new ApiError(403, "Only the owning faculty member can approve this exam");

  const { ok, issues } = await validateExamForApproval(examId);
  if (!ok) {
    throw new ApiError(422, "The exam cannot be approved until these issues are fixed:", { issues });
  }

  return prisma.$transaction(async (tx) => {
    // Freeze every draft rubric version — the approved version becomes the
    // authoritative grading specification (immutably versioned).
    const questions = await tx.examQuestion.findMany({
      where: { examId },
      include: { rubricVersions: { where: { status: "DRAFT" }, include: { criteria: true } } },
    });
    for (const q of questions) {
      for (const rubric of q.rubricVersions) {
        await tx.rubric.update({
          where: { id: rubric.id },
          data: { status: "APPROVED", approvedById: facultyId, approvedAt: new Date() },
        });
      }
    }
    return tx.exam.update({
      where: { id: examId },
      data: { status: "APPROVED", approvedById: facultyId, approvedAt: new Date() },
    });
  });
}

export async function publishExam(examId: string, facultyId: string) {
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    select: { status: true, courseId: true, approvedById: true },
  });
  if (!exam) throw new ApiError(404, "Exam not found");
  const course = await prisma.course.findUnique({ where: { id: exam.courseId }, select: { professorId: true } });
  if (course?.professorId !== facultyId) throw new ApiError(403, "Only the owning faculty member can publish this exam");
  if (exam.status !== "APPROVED") {
    throw new ApiError(409, "The exam must be approved before it can be published.");
  }
  return prisma.exam.update({ where: { id: examId }, data: { status: "PUBLISHED", publishedAt: new Date() } });
}

// ---- Draft editing (questions / rubric / order) -----------------------------

export async function updateDraftQuestion(
  examId: string,
  questionId: string,
  patch: Record<string, unknown>
) {
  await requireDraft(examId);
  const q = await prisma.examQuestion.findFirst({ where: { id: questionId, examId } });
  if (!q) throw new ApiError(404, "Question not found");

  const data: Record<string, unknown> = {};
  if (patch.text != null) data.text = String(patch.text);
  if (patch.marks != null) data.marks = Number(patch.marks);
  if (patch.difficulty !== undefined) data.difficulty = patch.difficulty ?? null;

  if (q.type === "MCQ") {
    if (patch.explanation !== undefined) data.explanation = patch.explanation ?? null;
    if (patch.options != null) {
      data.optionsJson = JSON.stringify(patch.options);
      // Keep the key consistent with new options when it stays valid.
      const opts = patch.options as Array<{ id: string }>;
      const key = (patch.correctAnswerId as string) || q.correctAnswerId;
      if (!opts.some((o) => o.id === key)) {
        throw new ApiError(422, "The correct answer must be one of the provided options.");
      }
      data.correctAnswerId = key;
    } else if (patch.correctAnswerId != null) {
      const opts = JSON.parse(q.optionsJson ?? "[]") as Array<{ id: string }>;
      if (!opts.some((o) => o.id === patch.correctAnswerId)) {
        throw new ApiError(422, "The correct answer must be one of the provided options.");
      }
      data.correctAnswerId = String(patch.correctAnswerId);
    }
  } else {
    if (patch.expectedAnswer !== undefined) data.expectedAnswer = String(patch.expectedAnswer);
  }

  await prisma.examQuestion.update({ where: { id: questionId }, data });
  if (patch.marks != null && q.type === "WRITING") {
    await recomputeRubricFix(questionId);
  }
  return prisma.examQuestion.findUnique({ where: { id: questionId }, include: { rubricVersions: { include: { criteria: true } } } });
}

export async function addDraftQuestion(
  examId: string,
  input: { type: "MCQ" | "WRITING"; text: string; marks: number; options?: Array<{ id: string; text: string }>; correctAnswerId?: string; explanation?: string | null; expectedAnswer?: string | null; difficulty?: string | null }
) {
  await requireDraft(examId);
  const count = await prisma.examQuestion.count({ where: { examId } });
  const data: Record<string, unknown> = {
    examId,
    order: count + 1,
    type: input.type,
    text: input.text,
    marks: input.marks,
    difficulty: input.difficulty ?? null,
  };
  if (input.type === "MCQ") {
    const opts = input.options ?? [
      { id: "A", text: "Option A" },
      { id: "B", text: "Option B" },
      { id: "C", text: "Option C" },
      { id: "D", text: "Option D" },
    ];
    const key = input.correctAnswerId ?? "A";
    if (!opts.some((o) => o.id === key)) throw new ApiError(422, "The correct answer must be one of the options.");
    data.optionsJson = JSON.stringify(opts);
    data.correctAnswerId = key;
    data.explanation = input.explanation ?? null;
  } else {
    data.expectedAnswer = input.expectedAnswer ?? "";
  }
  return prisma.examQuestion.create({ data: data as never });
}

export async function deleteDraftQuestion(examId: string, questionId: string) {
  await requireDraft(examId);
  const q = await prisma.examQuestion.findFirst({ where: { id: questionId, examId } });
  if (!q) throw new ApiError(404, "Question not found");
  await prisma.examQuestion.delete({ where: { id: questionId } });
  // renumber
  const remaining = await prisma.examQuestion.findMany({ where: { examId }, orderBy: { order: "asc" } });
  for (let i = 0; i < remaining.length; i++) {
    await prisma.examQuestion.update({ where: { id: remaining[i].id }, data: { order: i + 1 } });
  }
}

export async function reorderQuestions(examId: string, questionIds: string[]) {
  await requireDraft(examId);
  const current = await prisma.examQuestion.findMany({ where: { examId } });
  const set = new Set(current.map((q) => q.id));
  if (questionIds.some((id) => !set.has(id)) || questionIds.length !== current.length) {
    throw new ApiError(400, "Reorder payload must contain exactly the exam's questions.");
  }
  await prisma.$transaction(
    questionIds.map((id, i) => prisma.examQuestion.update({ where: { id }, data: { order: i + 1 } }))
  );
}

/** Replace the criteria of the current DRAFT rubric version (the immutable
 * approved version is untouched — new versions are created only while the
 * exam is a draft; after approval, editing requires regenerating a new
 * draft exam version in this build). */
export async function editDraftRubric(examId: string, questionId: string, criteriaInput: RubricPatch["criteria"]) {
  await requireDraft(examId);
  const q = await prisma.examQuestion.findFirst({ where: { id: questionId, examId }, include: { rubricVersions: { orderBy: { version: "desc" } } } });
  if (!q) throw new ApiError(404, "Question not found");
  if (q.type !== "WRITING") throw new ApiError(400, "Rubrics belong to writing questions");

  const latest = q.rubricVersions[0];
  if (!latest) throw new ApiError(404, "No rubric version exists for this question");
  if (latest.status !== "DRAFT") {
    throw new ApiError(409, "The approved rubric is immutable. Regenerate the draft exam or replace the question to change grading criteria.");
  }

  const criteria = rubricPatchSchema.parse({ criteria: criteriaInput }).criteria;
  await prisma.$transaction(async (tx) => {
    await tx.rubricCriterion.deleteMany({ where: { rubricId: latest.id } });
    await tx.rubricCriterion.createMany({
      data: criteria.map((c, i) => ({
        rubricId: latest.id,
        order: i + 1,
        name: c.name,
        description: c.description,
        maxMarks: c.maxMarks,
        fullCredit: c.fullCredit,
        partialCredit: c.partialCredit,
        commonMistakes: c.commonMistakes ?? null,
        acceptableAlternatives: c.acceptableAlternatives ?? null,
      })),
    });
  });
  await recomputeRubricFix(questionId);
  return prisma.rubric.findUnique({ where: { id: latest.id }, include: { criteria: { orderBy: { order: "asc" } } } });
}

export async function recomputeRubricFix(questionId: string): Promise<boolean> {
  const q = await prisma.examQuestion.findUnique({
    where: { id: questionId },
    include: { rubricVersions: { orderBy: { version: "desc" }, take: 1, include: { criteria: true } } },
  });
  if (!q?.rubricVersions[0] || q.type !== "WRITING") return false;
  const sum = criterionSum(q.rubricVersions[0]);
  const bad = Math.abs(sum - q.marks) > 1e-9;
  await prisma.examQuestion.update({ where: { id: questionId }, data: { needsRubricFix: bad } });
  return bad;
}
