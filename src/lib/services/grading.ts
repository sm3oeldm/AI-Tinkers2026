// Automatic grading pipeline (spec PART 3).
//
// 1. MCQs are graded DETERMINISTICALLY against the approved answer key — no
//    LLM involvement.
// 2. Writing answers are evaluated by the configured provider using the exact
//    professor-approved rubric version (prompt contains it verbatim; the model
//    cannot alter it).
// 3. Every model result is validated: schema → criterion id/max alignment →
//    per-criterion bounds → evidence quotes verified against the student's
//    answer → totals recomputed server-side (never trusting model totals).
// 4. Professor actions every write an append-only GradeAudit record.

import { prisma } from "../db";
import { ApiError } from "../http";
import { getProvider, providerDescription } from "../llm";
import { buildGradingPrompt, GradingRubricCriterion, PROMPT_VERSIONS } from "../prompts";
import { extractJson } from "../llm/types";
import { verifyQuote } from "../text";
import { llmGradeOutputSchema, LlmGradeOutput } from "../validation";

// ---------------------------------------------------------------------------
// Student flow
// ---------------------------------------------------------------------------

export async function startSubmission(examId: string, studentId: string) {
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: { questions: { orderBy: { order: "asc" } }, course: { include: { enrollments: true } } },
  });
  if (!exam) throw new ApiError(404, "Exam not found");
  if (exam.status !== "PUBLISHED") throw new ApiError(409, "This exam is not published yet.");
  if (!exam.course.enrollments.some((e) => e.userId === studentId)) {
    throw new ApiError(403, "You are not enrolled in this course.");
  }

  const existing = await prisma.examSubmission.findUnique({
    where: { examId_studentId: { examId, studentId } },
  });
  if (existing && existing.status !== "IN_PROGRESS") {
    throw new ApiError(409, "You have already submitted this exam.");
  }
  if (existing) return existing;

  const maxMarks = exam.questions.reduce((a, q) => a + q.marks, 0);
  return prisma.examSubmission.create({
    data: { examId, studentId, maxMarks, status: "IN_PROGRESS", answers: { create: [] } },
  });
}

export async function saveAnswer(
  submissionId: string,
  studentId: string,
  patch: { questionId: string; selectedOptionId?: string | null; text?: string | null }
) {
  const submission = await prisma.examSubmission.findUnique({
    where: { id: submissionId },
    include: { exam: { select: { status: true, questions: { select: { id: true, type: true, optionsJson: true } } } } },
  });
  if (!submission) throw new ApiError(404, "Submission not found");
  if (submission.studentId !== studentId) throw new ApiError(403, "Not your submission");
  if (submission.status !== "IN_PROGRESS") throw new ApiError(409, "This submission was already handed in.");

  const q = submission.exam.questions.find((qq) => qq.id === patch.questionId);
  if (!q) throw new ApiError(404, "Question not part of this exam");
  if (q.type === "MCQ") {
    if (patch.text != null) throw new ApiError(400, "MCQ answers use option selection");
    if (patch.selectedOptionId) {
      const options = JSON.parse(q.optionsJson ?? "[]") as Array<{ id: string }>;
      if (!options.some((o) => o.id === patch.selectedOptionId)) {
        throw new ApiError(400, "Selected option is not valid for this question");
      }
    }
  } else if (patch.selectedOptionId != null) {
    throw new ApiError(400, "Writing questions accept text answers");
  }

  await prisma.answer.upsert({
    where: { submissionId_questionId: { submissionId, questionId: patch.questionId } },
    create: {
      submissionId,
      questionId: patch.questionId,
      selectedOptionId: patch.selectedOptionId ?? null,
      text: patch.text ?? null,
    },
    update: {
      selectedOptionId: patch.selectedOptionId ?? null,
      text: patch.text ?? null,
    },
  });
  return { saved: true };
}

/** Submit: idempotent hand-in triggering the two independent grading stages. */
export async function submitExam(submissionId: string, studentId: string) {
  const submission = await prisma.examSubmission.findUnique({
    where: { id: submissionId },
    include: { exam: { include: { questions: { orderBy: { order: "asc" } } } } },
  });
  if (!submission) throw new ApiError(404, "Submission not found");
  if (submission.studentId !== studentId) throw new ApiError(403, "Not your submission");
  if (submission.status !== "IN_PROGRESS") {
    // Idempotency: repeat submissions do not re-trigger grading.
    return { submissionId, status: submission.status, duplicate: true };
  }

  const answers = await prisma.answer.findMany({ where: { submissionId } });
  const answerTexts = new Map(answers.map((a) => [a.questionId, a]));

  // ---- Stage 1: deterministic MCQ grading (transaction, no LLM) ----------
  const mcqResults = await prisma.$transaction(async (tx) => {
    const perQuestion: Record<string, number> = {};
    let mcqTotal = 0;
    for (const q of submission.exam.questions.filter((x) => x.type === "MCQ")) {
      const a = answerTexts.get(q.id);
      const selected = a?.selectedOptionId ?? null;
      const awarded = selected && selected === q.correctAnswerId ? q.marks : 0;
      await tx.answer.upsert({
        where: { submissionId_questionId: { submissionId, questionId: q.id } },
        create: { submissionId, questionId: q.id, selectedOptionId: selected, awardedMarks: awarded, gradedBy: "MCQ_KEY" },
        update: { awardedMarks: awarded, gradedBy: "MCQ_KEY" },
      });
      perQuestion[q.id] = awarded;
      mcqTotal += awarded;
    }
    return { perQuestion, mcqTotal };
  });

  await prisma.examSubmission.update({
    where: { id: submissionId },
    data: { status: "GRADING", submittedAt: new Date(), mcqMarks: mcqResults.mcqTotal },
  });

  // ---- Stage 2: writing grading (LLM, per answer) ------------------------
  let writingTotal = 0;
  for (const q of submission.exam.questions.filter((x) => x.type === "WRITING")) {
    const text = answerTexts.get(q.id)?.text ?? "";
    const result = await gradeWritingAnswer(submissionId, q, text, 1);
    if (result.status === "SUCCEEDED" || result.status === "REQUIRES_REVIEW" || result.status === "PROFESSOR_OVERRIDE") {
      writingTotal += result.newTotal;
    }
  }

  // ---- Stage 3: totals + provisional status --------------------------------
  const totalMarks = mcqResults.mcqTotal + writingTotal;
  const updated = await prisma.$transaction(async (tx) => {
    const sub = await tx.examSubmission.update({
      where: { id: submissionId },
      data: { status: "PROVISIONAL", writingMarks: writingTotal, totalMarks },
    });
    await tx.gradeAudit.create({
      data: {
        submissionId,
        action: "GRADED",
        previousJson: null,
        newJson: JSON.stringify({ status: "PROVISIONAL", mcqMarks: mcqResults.mcqTotal, writingMarks: writingTotal, totalMarks, mcqPerQuestion: mcqResults.perQuestion }),
      },
    });
    return sub;
  });

  return { submissionId: updated.id, status: updated.status, duplicate: false };
}

// ---------------------------------------------------------------------------
// Writing question grading against the APPROVED rubric
// ---------------------------------------------------------------------------

export interface GradedAnswerOutcome {
  gradeId: string;
  status: string;
  newTotal: number;
}

const ACCEPTING_STATUSES = new Set(["SUCCEEDED", "REQUIRES_REVIEW", "PROFESSOR_OVERRIDE"]);

async function loadApprovedRubric(questionId: string) {
  const rubric = await prisma.rubric.findFirst({
    where: { questionId, status: "APPROVED" },
    orderBy: { version: "desc" },
    include: { criteria: { orderBy: { order: "asc" } } },
  });
  return rubric; // may be null
}

/** Grade one writing answer. Returns the created grade row info. */
export async function gradeWritingAnswer(
  submissionId: string,
  question: { id: string; text: string; marks: number },
  studentAnswer: string,
  attempt: number
): Promise<GradedAnswerOutcome> {
  const rubric = await loadApprovedRubric(question.id);
  if (!rubric || rubric.criteria.length === 0) {
    // Should not happen for approved exams, but never fabricate marks.
    const grade = await persistUngradable(question, submissionId, attempt, rubric,
      "No approved rubric version is available for this question.");
    return grade;
  }

  const provider = getProvider();
  const providerInfo = providerDescription();

  // Unanswered writing: zero marks, no LLM call needed.
  if (!studentAnswer || !studentAnswer.trim()) {
    const grade = await persistZeroGrades(
      submissionId,
      question,
      rubric,
      providerInfo,
      attempt,
      "No answer was submitted for this question."
    );
    return grade;
  }

  const examSubmission = await prisma.examSubmission.findUnique({
    where: { id: submissionId },
    select: { exam: { select: { title: true, instructions: true } } },
  });
  const examTitle = examSubmission?.exam.title ?? "Exam";
  const examInstructions = examSubmission?.exam.instructions ?? null;

  const rubricForModel: GradingRubricCriterion[] = rubric.criteria.map((c) => ({
    criterion_id: `criterion_${c.order}`,
    name: c.name,
    max_marks: c.maxMarks,
    description: c.description,
    full_credit: c.fullCredit,
    partial_credit: c.partialCredit,
    common_mistakes: c.commonMistakes,
    acceptable_alternatives: c.acceptableAlternatives,
  }));

  let lastError = "";
  for (let attemptIdx = 1; attemptIdx <= 2; attemptIdx++) {
    const isLast = attemptIdx === 2;
    const prompt = buildGradingPrompt({
      examTitle,
      questionText: question.text,
      maxMarks: question.marks,
      rubric: rubricForModel,
      expectedAnswer: null,
      studentAnswer,
      professorInstructions: examInstructions,
    });
    if (lastError) {
      prompt.userPrompt += `\nCORRECTION: your previous response was rejected because: ${lastError}. Re-check the rubric ids/maximums and return exactly one valid JSON object.`;
    }
    try {
      const res = await provider.generate(prompt, { temperature: 0.1 });
      const parsed = llmGradeOutputSchema.parse(extractJson(res.text));
      const aligned = alignAgainstRubric(parsed, rubric, studentAnswer);
      if (!aligned.ok) {
        lastError = aligned.error;
        if (isLast) {
          return await persistUngradable(question, submissionId, attempt, rubric, `Grading output rejected: ${aligned.error}`, providerInfo);
        }
        continue;
      }
      return await persistGrade(submissionId, question, rubric, providerInfo, attempt, aligned);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return await persistUngradable(question, submissionId, attempt, rubric, `Grading failed after 2 attempts: ${lastError}`, providerInfo);
}

interface AlignedCriterion {
  criterionId: string;
  criterionName: string;
  maxMarks: number;
  awardedMarks: number;
  evidence: Array<{ quote: string; explanation: string; verified: boolean }>;
  feedback: string;
  flagged: boolean;
  flagReasons: string[];
}

/** Deterministic backend validation of model output. This is where "never
 * blindly trust the model" is enforced: canonical names/maxes come from the
 * DB rubric; awards are clamped; evidence quotes are verified. */
function alignAgainstRubric(
  parsed: LlmGradeOutput,
  rubric: NonNullable<Awaited<ReturnType<typeof loadApprovedRubric>>>,
  studentAnswer: string
): { ok: true; criteria: AlignedCriterion[]; reviewReasons: string[]; evidenceIssues: string[] } | { ok: false; error: string } {
  const byId = new Map(rubric.criteria.map((c) => [`criterion_${c.order}`, c]));
  const seen = new Set<string>();
  const criteria: AlignedCriterion[] = [];
  const reviewReasons: string[] = [...(parsed.requires_human_review ? parsed.review_reasons : [])];
  if (parsed.requires_human_review) reviewReasons.push(...parsed.review_reasons);
  const evidenceIssues: string[] = [];

  for (const r of parsed.criteria_results) {
    if (seen.has(r.criterion_id)) return { ok: false, error: `criterion "${r.criterion_id}" appears more than once` };
    seen.add(r.criterion_id);
    const canonical = byId.get(r.criterion_id);
    if (!canonical) {
      return { ok: false, error: `unknown criterion id "${r.criterion_id}" (rubric has ${[...byId.values()].map((c) => "criterion_" + c.order).join(", ")})` };
    }
    const criterionResult: AlignedCriterion = {
      criterionId: `criterion_${canonical.order}`,
      criterionName: canonical.name,
      maxMarks: canonical.maxMarks,
      awardedMarks: 0,
      evidence: [],
      feedback: r.feedback,
      flagged: false,
      flagReasons: [],
    };

    if (Math.abs(r.maximum_marks - canonical.maxMarks) > 1e-9) {
      return { ok: false, error: `criterion "criterion_${canonical.order}" maximum (${r.maximum_marks}) does not match the approved rubric (${canonical.maxMarks}). The approved rubric cannot be modified.` };
    }

    let awarded = Math.round(r.awarded_marks * 2) / 2;
    if (awarded < 0) return { ok: false, error: `negative marks for "criterion_${canonical.order}"` };
    if (awarded > canonical.maxMarks) {
      awarded = canonical.maxMarks;
      criterionResult.flagged = true;
      criterionResult.flagReasons.push("awarded_marks_exceeded_maximum_clamped");
      reviewReasons.push(`marks clamped: criterion ${criterionResult.criterionId} awarded ${r.awarded_marks} > max ${canonical.maxMarks}`);
    }

    for (const evItem of r.evidence) {
      const ver = verifyQuote(evItem.quote, studentAnswer);
      if (!ver.found) {
        criterionResult.flagged = true;
        criterionResult.flagReasons.push("evidence_not_found_in_answer");
        reviewReasons.push(`evidence not found in student answer (criterion ${criterionResult.criterionId}): "${evItem.quote.slice(0, 80)}"`);
        evidenceIssues.push(`Criterion ${criterionResult.criterionId}: quoted evidence not verifiable in the submission.`);
      }
      criterionResult.evidence.push({ quote: evItem.quote, explanation: evItem.explanation, verified: ver.found });
    }
    if (awarded > 0 && criterionResult.evidence.length === 0) {
      criterionResult.flagged = true;
      criterionResult.flagReasons.push("marks_without_evidence");
      reviewReasons.push(`criterion ${criterionResult.criterionId} awarded marks without any supporting evidence`);
    }

    criterionResult.awardedMarks = awarded;
    criteria.push(criterionResult);
  }

  // every approved criterion must be evaluated
  for (const c of rubric.criteria) {
    if (!seen.has(`criterion_${c.order}`)) {
      return { ok: false, error: `criterion "criterion_${c.order}" (${c.name}) is missing from the evaluation` };
    }
  }

  return { ok: true, criteria, reviewReasons, evidenceIssues };
}

// ---- persistence helpers ----------------------------------------------------

async function persistGrade(
  submissionId: string,
  question: { id: string; marks: number },
  rubric: NonNullable<Awaited<ReturnType<typeof loadApprovedRubric>>>,
  providerInfo: { provider: string; model: string; keyConfigured: boolean },
  attempt: number,
  aligned: { criteria: AlignedCriterion[]; reviewReasons: string[]; evidenceIssues: string[] }
): Promise<GradedAnswerOutcome> {
  const total = aligned.criteria.reduce((a, c) => a + c.awardedMarks, 0);
  const status = aligned.reviewReasons.length > 0 ? "REQUIRES_REVIEW" : "SUCCEEDED";
  const previous = await latestGrade(submissionId, question.id);

  const grade = await prisma.$transaction(async (tx) => {
    const g = await tx.writingQuestionGrade.create({
      data: {
        submissionId,
        questionId: question.id,
        rubricId: rubric.id,
        rubricVersion: rubric.version,
        attempt,
        status,
        awardedMarks: total,
        maxMarks: question.marks,
        feedback: null,
        evidenceIssuesJson: JSON.stringify(aligned.evidenceIssues),
        reviewReasonsJson: aligned.reviewReasons.length ? JSON.stringify(aligned.reviewReasons) : null,
        model: providerInfo.provider,
        promptVersion: "writing_grading_v1",
        criteria: {
          create: aligned.criteria.map((c, i) => ({
            order: i + 1,
            criterionId: c.criterionId,
            criterionName: c.criterionName,
            maxMarks: c.maxMarks,
            awardedMarks: c.awardedMarks,
            evidenceJson: JSON.stringify(c.evidence),
            feedback: c.feedback,
            flagged: c.flagged,
            flagReasonsJson: c.flagReasons.length ? JSON.stringify(c.flagReasons) : null,
          })),
        },
      },
    });
    await tx.answer.updateMany({
      where: { submissionId, questionId: question.id },
      data: { awardedMarks: total, gradedBy: "AI" },
    });
    await tx.gradeAudit.create({
      data: {
        submissionId,
        questionId: question.id,
        action: "GRADED",
        actorId: null,
        previousJson: previous ? JSON.stringify(previous) : null,
        newJson: JSON.stringify({ status: status, awardedMarks: total, rubricVersion: rubric.version, attempt }),
      },
    });
    return g;
  });

  return { gradeId: grade.id, status, newTotal: total };
}

async function persistZeroGrades(
  submissionId: string,
  question: { id: string; text: string; marks: number },
  rubric: NonNullable<Awaited<ReturnType<typeof loadApprovedRubric>>>,
  providerInfo: { provider: string; model: string; keyConfigured: boolean },
  attempt: number,
  reason: string
): Promise<GradedAnswerOutcome> {
  const criteria = rubric.criteria.map((c, i) => ({
    order: i + 1,
    criterionId: `criterion_${c.order}`,
    criterionName: c.name,
    maxMarks: c.maxMarks,
    awardedMarks: 0,
    evidenceJson: JSON.stringify([]),
    feedback: reason,
    flagged: false,
    flagReasonsJson: null,
  }));
  const grade = await persistGradeRows(submissionId, question, rubric, providerInfo, attempt, {
    status: "SUCCEEDED",
    awardedMarks: 0,
    feedback: reason,
    criteria,
    reviewReasonsJson: null,
    evidenceIssuesJson: null,
  });
  return { gradeId: grade.id, status: "SUCCEEDED", newTotal: 0 };
}

async function persistGradeRows(
  submissionId: string,
  question: { id: string; marks: number },
  rubric: NonNullable<Awaited<ReturnType<typeof loadApprovedRubric>>>,
  _providerInfo: { provider: string; model: string; keyConfigured: boolean },
  attempt: number,
  input: {
    status: string;
    awardedMarks: number;
    feedback: string | null;
    criteria: Array<Record<string, unknown>>;
    reviewReasonsJson: string | null;
    evidenceIssuesJson: string | null;
  }
) {
  const previous = await latestGrade(submissionId, question.id);
  return prisma.$transaction(async (tx) => {
    const g = await tx.writingQuestionGrade.create({
      data: {
        submissionId,
        questionId: question.id,
        rubricId: rubric.id,
        rubricVersion: rubric.version,
        attempt,
        model: _providerInfo.model,
        promptVersion: PROMPT_VERSIONS.writingGrading,
        status: input.status,
        awardedMarks: input.awardedMarks,
        maxMarks: question.marks,
        feedback: input.feedback,
        evidenceIssuesJson: input.evidenceIssuesJson,
        reviewReasonsJson: input.reviewReasonsJson,
        criteria: { create: input.criteria as never },
      },
    });
    return g;
  });
}

async function persistUngradable(
  question: { id: string; text: string; marks: number },
  submissionId: string,
  attempt: number,
  rubric: Awaited<ReturnType<typeof loadApprovedRubric>>,
  reason: string,
  providerInfo?: { provider: string; model: string; keyConfigured: boolean }
): Promise<GradedAnswerOutcome> {
  await prisma.$transaction(async (tx) => {
    await tx.answer.updateMany({
      where: { submissionId, questionId: question.id },
      data: { awardedMarks: null, gradedBy: null },
    });
  });
  if (!rubric) {
    const g = await prisma.writingQuestionGrade.create({
      data: {
        submissionId,
        questionId: question.id,
        rubricId: "",
        rubricVersion: 0,
        attempt,
        model: "none",
        promptVersion: PROMPT_VERSIONS.writingGrading,
        status: "FAILED",
        awardedMarks: 0,
        maxMarks: question.marks,
        feedback: null,
        reviewReasonsJson: JSON.stringify([reason]),
        criteria: { create: [] },
      },
    });
    return { gradeId: g.id, status: "FAILED", newTotal: 0 };
  }
  const providerInfoSafe = providerInfo ?? providerDescription();
  const g = await persistGradeRows(submissionId, question, rubric, providerInfoSafe, attempt, {
    status: "FAILED",
    awardedMarks: 0,
    feedback: "The automated grading result was rejected and must be set or approved manually.",
    criteria: rubric.criteria.map((c, i) => ({
      order: i + 1,
      criterionId: `criterion_${c.order}`,
      criterionName: c.name,
      maxMarks: c.maxMarks,
      awardedMarks: 0,
      evidenceJson: JSON.stringify([]),
      feedback: reason,
      flagged: false,
      flagReasonsJson: null,
    })),
    reviewReasonsJson: JSON.stringify([reason]),
    evidenceIssuesJson: null,
  });
  return { gradeId: g.id, status: "FAILED", newTotal: 0 };
}

export async function latestGrade(submissionId: string, questionId: string) {
  return prisma.writingQuestionGrade.findFirst({
    where: { submissionId, questionId },
    orderBy: { attempt: "desc" },
    include: { criteria: { orderBy: { order: "asc" } } },
  });
}

// ---------------------------------------------------------------------------
// Professor review actions (each one audited, nothing overwritten)
// ---------------------------------------------------------------------------

async function requireFacultySubmission(submissionId: string, facultyId: string) {
  const submission = await prisma.examSubmission.findUnique({
    where: { id: submissionId },
    include: { exam: { select: { courseId: true, questions: { select: { id: true, marks: true, type: true } }, course: { select: { professorId: true, title: true } } } } },
  });
  if (!submission) throw new ApiError(404, "Submission not found");
  if (submission.exam.course.professorId !== facultyId) {
    throw new ApiError(403, "Only the owning faculty member can review submissions of this exam.");
  }
  return submission;
}

export async function overrideWritingMarks(
  submissionId: string,
  questionId: string,
  facultyId: string,
  criterionMarks: Array<{ criterionId: string; awardedMarks: number }>,
  feedback: string | null,
  reason: string
) {
  const submission = await requireFacultySubmission(submissionId, facultyId);
  if (submission.status === "PUBLISHED") throw new ApiError(409, "Results are released; overrides are not allowed.");
  if (submission.status !== "PROVISIONAL" && submission.status !== "APPROVED") {
    throw new ApiError(409, `Grades are still ${submission.status}. Overrides apply after grading completes.`);
  }
  const wasApproved = submission.status === "APPROVED";
  const question = submission.exam.questions.find((x) => x.id === questionId);
  if (!question) throw new ApiError(404, "Question not part of this exam");
  const previous = await latestGrade(submissionId, questionId);
  if (!previous) throw new ApiError(404, "No grade exists for this question yet");
  const rubric = await prisma.rubric.findUnique({ where: { id: previous.rubricId }, include: { criteria: { orderBy: { order: "asc" } } } });
  if (!rubric) throw new ApiError(500, "Approved rubric missing");
  if (rubric.questionId !== questionId) throw new ApiError(409, "Rubric mismatch");

  const markMap = new Map(criterionMarks.map((m) => [m.criterionId, m.awardedMarks]));
  const criteria = rubric.criteria.map((c, i) => {
    const granted = markMap.get(`criterion_${c.order}`);
    if (granted === undefined) throw new ApiError(422, `Provide marks for criterion_${c.order} (${c.name})`);
    if (granted < 0 || granted > c.maxMarks) {
      throw new ApiError(422, `Marks for criterion_${c.order} must be between 0 and ${c.maxMarks} (received ${granted}).`);
    }
    return {
      order: i + 1,
      criterionId: `criterion_${c.order}`,
      criterionName: c.name,
      maxMarks: c.maxMarks,
      awardedMarks: granted,
      evidenceJson: JSON.stringify([]),
      feedback: "",
      flagged: false,
      flagReasonsJson: null,
    };
  });

  const total = criteria.reduce((a, c) => a + c.awardedMarks, 0);

  await prisma.$transaction(async (tx) => {
    await tx.writingQuestionGrade.create({
      data: {
        submissionId,
        questionId,
        rubricId: rubric.id,
        rubricVersion: rubric.version,
        attempt: previous.attempt + 1,
        model: "professor-override",
        promptVersion: PROMPT_VERSIONS.writingGrading,
        status: "PROFESSOR_OVERRIDE",
        awardedMarks: total,
        maxMarks: question.marks,
        feedback,
        reviewReasonsJson: JSON.stringify([`overridden by faculty: ${reason}`]),
        criteria: { create: criteria },
      },
    });
    await tx.answer.updateMany({
      where: { submissionId, questionId },
      data: { awardedMarks: total, gradedBy: "PROFESSOR" },
    });
    if (wasApproved) {
      // A changed breakdown requires fresh approval before release.
      await tx.examSubmission.update({ where: { id: submissionId }, data: { status: "PROVISIONAL" } });
    }
    await tx.gradeAudit.create({
      data: {
        submissionId,
        questionId,
        action: "PROFESSOR_OVERRIDE",
        actorId: facultyId,
        previousJson: JSON.stringify({ status: previous.status, awardedMarks: previous.awardedMarks, attempt: previous.attempt, rubricVersion: previous.rubricVersion }),
        newJson: JSON.stringify({ status: wasApproved ? "PROVISIONAL (override after approval — re-approve required)" : "PROFESSOR_OVERRIDE", awardedMarks: total, attempt: previous.attempt + 1, rubricVersion: rubric.version, criteria }),
        reason,
      },
    });
  });

  await recalculateTotals(submissionId);
  return { ok: true, awardedMarks: total };
}

export async function approveQuestion(submissionId: string, questionId: string, facultyId: string, reason: string | null) {
  await requireFacultySubmission(submissionId, facultyId);
  const latest = await latestGrade(submissionId, questionId);
  if (!latest) throw new ApiError(404, "No grade exists for this question");
  await prisma.gradeAudit.create({
    data: {
      submissionId,
      questionId,
      action: "PROFESSOR_APPROVE",
      actorId: facultyId,
      previousJson: null,
      newJson: JSON.stringify({ gradeId: latest.id, awardedMarks: latest.awardedMarks, status: latest.status }),
      reason: reason ?? "approved AI/professor marks for this question",
    },
  });
  return { ok: true };
}

/** Approve the whole submission: requires every writing question to have an
 * acceptably-graded latest attempt (FAILED rows must be overridden first). */
export async function approveAll(submissionId: string, facultyId: string, reason: string | null) {
  const submission = await requireFacultySubmission(submissionId, facultyId);
  if (!["PROVISIONAL"].includes(submission.status)) {
    throw new ApiError(409, `Cannot approve while status is ${submission.status}.`);
  }
  const writingQuestions = submission.exam.questions.filter((q) => q.type === "WRITING");
  const blockers: string[] = [];
  const latestPerQuestion = new Map<string, { id: string; awardedMarks: number; status: string }>();
  for (const q of writingQuestions) {
    const latest = await latestGrade(submissionId, q.id);
    if (!latest) blockers.push(`question ${q.id}: no grading result`);
    else if (!ACCEPTING_STATUSES.has(latest.status)) blockers.push(`question ${q.id}: grading status ${latest.status} (override it first)`);
    else latestPerQuestion.set(q.id, { id: latest.id, awardedMarks: latest.awardedMarks, status: latest.status });
  }
  if (blockers.length) throw new ApiError(422, "Resolve these questions before approving:", { blockers });

  await prisma.$transaction(async (tx) => {
    await tx.examSubmission.update({ where: { id: submissionId }, data: { status: "APPROVED" } });
    await tx.gradeAudit.create({
      data: {
        submissionId,
        action: "PROFESSOR_APPROVE",
        actorId: facultyId,
        previousJson: JSON.stringify({ status: submission.status, totalMarks: submission.totalMarks }),
        newJson: JSON.stringify({ status: "APPROVED", totalMarks: submission.totalMarks }),
        reason: reason ?? "faculty approved the provisional grades",
      },
    });
    for (const [, latest] of latestPerQuestion) {
      await tx.gradeAudit.create({
        data: {
          submissionId,
          questionId: questionIdOf(latestPerQuestion, latest.id),
          action: "PROFESSOR_APPROVE",
          actorId: facultyId,
          previousJson: null,
          newJson: JSON.stringify({ gradeId: latest.id, awardedMarks: latest.awardedMarks, status: latest.status }),
          reason: "approved as part of approve_all",
        },
      });
    }
  });
  return { ok: true };
}

function questionIdOf(map: Map<string, { id: string; awardedMarks: number; status: string }>, gradeId: string): string {
  for (const [qid, v] of map) if (v.id === gradeId) return qid;
  return "";
}

export async function releaseResults(submissionId: string, facultyId: string, reason: string | null) {
  const submission = await requireFacultySubmission(submissionId, facultyId);
  if (submission.status !== "APPROVED") {
    throw new ApiError(409, "Approve the provisional grades before releasing results to the student.");
  }
  await prisma.$transaction(async (tx) => {
    await tx.examSubmission.update({
      where: { id: submissionId },
      data: { status: "PUBLISHED", releasedAt: new Date() },
    });
    await tx.gradeAudit.create({
      data: {
        submissionId,
        action: "RELEASED",
        actorId: facultyId,
        previousJson: JSON.stringify({ status: "APPROVED" }),
        newJson: JSON.stringify({ status: "PUBLISHED", totalMarks: submission.totalMarks }),
        reason: reason ?? "results released to the student",
      },
    });
  });
  return { ok: true };
}

export async function regradeQuestion(submissionId: string, questionId: string, facultyId: string, reason: string | null) {
  const submission = await requireFacultySubmission(submissionId, facultyId);
  if (submission.status === "PUBLISHED") throw new ApiError(409, "Results are released; regrade is not allowed.");
  const question = submission.exam.questions.find((x) => x.id === questionId);
  if (!question || question.type !== "WRITING") throw new ApiError(404, "Writing question not found in this exam");

  const previous = await latestGrade(submissionId, questionId);
  const answers = await prisma.answer.findFirst({ where: { submissionId, questionId } });
  const attempt = (previous?.attempt ?? 0) + 1;

  const qFull = await prisma.examQuestion.findUniqueOrThrow({
    where: { id: questionId },
    select: { id: true, text: true, marks: true, type: true },
  });
  const outcome = await gradeWritingAnswer(submissionId, qFull, answers?.text ?? "", attempt);
  await prisma.gradeAudit.create({
    data: {
      submissionId,
      questionId,
      action: "REGRADE",
      actorId: facultyId,
      previousJson: previous ? JSON.stringify({ status: previous.status, awardedMarks: previous.awardedMarks, attempt: previous.attempt, rubricVersion: previous.rubricVersion }) : null,
      newJson: JSON.stringify({ status: outcome.status, awardedMarks: outcome.newTotal, attempt }),
      reason: reason ?? "faculty requested regrading",
    },
  });
  await recalculateTotals(submissionId);
  return outcome;
}

/** Backend-authoritative totals: recomputed from the latest attempt per
 * question on every mutation. */
export async function recalculateTotals(submissionId: string) {
  const submission = await prisma.examSubmission.findUnique({
    where: { id: submissionId },
    include: { exam: { select: { questions: { select: { id: true, type: true } } } } },
  });
  if (!submission) throw new ApiError(404, "Submission not found");

  const writingIds = submission.exam.questions.filter((q) => q.type === "WRITING").map((q) => q.id);
  const grades = await prisma.writingQuestionGrade.findMany({
    where: { submissionId, questionId: { in: writingIds } },
    orderBy: { attempt: "desc" },
  });
  const latestPerQuestion = new Map<string, (typeof grades)[number]>();
  for (const g of grades) if (!latestPerQuestion.has(g.questionId)) latestPerQuestion.set(g.questionId, g);

  let writingTotal = 0;
  for (const [, g] of latestPerQuestion) {
    if (ACCEPTING_STATUSES.has(g.status)) writingTotal += g.awardedMarks;
  }

  const mcqAgg = await prisma.answer.aggregate({
    where: { submissionId, question: { examId: submission.examId, type: "MCQ" } },
    _sum: { awardedMarks: true },
  });
  const mcqMarks = mcqAgg._sum.awardedMarks ?? 0;

  return prisma.examSubmission.update({
    where: { id: submissionId },
    data: { mcqMarks, writingMarks: writingTotal, totalMarks: mcqMarks + writingTotal },
  });
}
