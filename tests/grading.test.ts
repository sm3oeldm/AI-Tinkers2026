import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resetDb, prisma, makeUser, makeCourseWithDocs, generateExam } from "./helpers";
import { approveExam, publishExam } from "../src/lib/services/exam-workflow";
import { startSubmission, submitExam, overrideWritingMarks, approveAll, releaseResults, regradeQuestion, latestGrade } from "../src/lib/services/grading";
import { getReleasedSubmission } from "../src/lib/services/results";
import { verifyQuote, questionDuplicateScore } from "../src/lib/text";

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await prisma.$disconnect(); });

describe("Text layer", () => {
  it("verifies verbatim evidence quotes and rejects fabricated ones", () => {
    const answer = "The net force equals zero, so the box keeps moving at a constant velocity.";
    expect(verifyQuote("net force equals zero", answer).found).toBe(true);
    expect(verifyQuote("This sentence was never typed by the student.", answer).found).toBe(false);
  });
  it("flags duplicate questions", () => {
    expect(questionDuplicateScore("What is the net force of a 2 kg box pushed with 6 N?", "What is the net force of a 2kg box pushed with 6 N?")).toBeGreaterThan(0.7);
    expect(questionDuplicateScore("Define momentum for a rocket.", "Explain static friction on an incline.")).toBeLessThan(0.7);
  });
});

describe("Automatic grading", () => {
  let facultyId: string;
  let studentId: string;
  let examId: string;

  beforeAll(async () => {
    facultyId = (await makeUser("grFaculty", "FACULTY")).id;
    studentId = (await makeUser("grStudent", "STUDENT")).id;
    const { course, chapterIds } = await makeCourseWithDocs(facultyId, { chapters: ["Forces"] });
    await prisma.enrollment.create({ data: { courseId: course.id, userId: studentId } });
    const gen = await generateExam(course.id, facultyId, chapterIds, {
      mcq: { count: 2, marksPerQuestion: 2 },
      writing: { count: 2, marksPerQuestion: 10 },
    });
    examId = gen.examId;
    await approveExam(examId, facultyId);
    await publishExam(examId, facultyId);
  });

  it("grades MCQs deterministically from the answer key (no LLM); wrong answers get 0", async () => {
    const exam = await prisma.exam.findUnique({ where: { id: examId }, include: { questions: true } });
    const mcqs = exam!.questions.filter((q) => q.type === "MCQ");
    const sub = await startSubmission(examId, studentId);
    // first correct, second wrong
    await prisma.answer.create({
      data: { submissionId: sub.id, questionId: mcqs[0].id, selectedOptionId: mcqs[0].correctAnswerId! },
    });
    const wrong = (JSON.parse(mcqs[1].optionsJson!) as Array<{ id: string }>).find((o) => o.id !== mcqs[1].correctAnswerId)!.id;
    await prisma.answer.create({ data: { submissionId: sub.id, questionId: mcqs[1].id, selectedOptionId: wrong } });

    const result = await submitExam(sub.id, studentId);
    expect(result.status).toBe("PROVISIONAL");

    const answers = await prisma.answer.findMany({ where: { submissionId: sub.id, question: { type: "MCQ" } } });
    expect(answers.filter((a) => a.awardedMarks === 2)).toHaveLength(1);
    expect(answers.filter((a) => a.awardedMarks === 0)).toHaveLength(1);
    expect(answers.every((a) => a.gradedBy === "MCQ_KEY")).toBe(true);
  });

  it("writing answers graded against the saved approved rubric with partial credit and verified evidence", async () => {
    const sub = await prisma.examSubmission.findFirstOrThrow({ where: { examId, studentId } });
    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId }, include: { questions: true } });
    const writing = exam.questions.find((q) => q.type === "WRITING")!;
    const answerText = "The laws of Forces conserve central quantities and forces produce proportional acceleration according to F equals m a. labeled experiments explain net force rules clearly.";
    await prisma.answer.upsert({
      where: { submissionId_questionId: { submissionId: sub.id, questionId: writing.id } },
      create: { submissionId: sub.id, questionId: writing.id, text: answerText },
      update: { text: answerText },
    });
    await regradeQuestion(sub.id, writing.id, facultyId, "post-submission check");

    const grade = await latestGrade(sub.id, writing.id);
    expect(grade!.status === "SUCCEEDED" || grade!.status === "REQUIRES_REVIEW").toBe(true);
    // rubric immutability: stored grade references an APPROVED rubric version
    const rubric = await prisma.rubric.findUnique({ where: { id: grade!.rubricId } });
    expect(rubric!.status).toBe("APPROVED");
    // evidence quotes come from the actual submitted answer (verified)
    const criteria = await prisma.criterionGrade.findMany({ where: { gradeId: grade!.id } });
    for (const c of criteria) {
      const evidence = JSON.parse(c.evidenceJson) as Array<{ verified: boolean }>;
      expect(evidence.every((e) => e.verified)).toBe(true);
    }
    // backend recomputed total = Σ criterion marks
    const sum = criteria.reduce((a, c) => a + c.awardedMarks, 0);
    expect(grade!.awardedMarks).toBe(sum);
  });

  it("clamps marks that exceed a criterion max and flags the criterion", async () => {
    const sub = await prisma.examSubmission.findFirstOrThrow({ where: { examId, studentId } });
    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId }, include: { questions: true } });
    const writing = exam.questions.filter((q) => q.type === "WRITING")[1];
    await prisma.answer.upsert({
      where: { submissionId_questionId: { submissionId: sub.id, questionId: writing.id } },
      create: { submissionId: sub.id, questionId: writing.id, text: "##INJECT_MAX_VIOLATION The laws of Forces conserve central quantities and F equals m a explains proportional acceleration with labeled examples." },
      update: { text: "##INJECT_MAX_VIOLATION The laws of Forces conserve central quantities and F equals m a explains proportional acceleration with labeled examples." },
    });
    await regradeQuestion(sub.id, writing.id, facultyId, "clamp test");
    const grade = await latestGrade(sub.id, writing.id);
    const flagged = (await prisma.criterionGrade.findMany({ where: { gradeId: grade!.id } })).some((c) => c.flagged);
    const firstMax = (grade!.awardedMarks <= 10);
    expect(flagged).toBe(true);
    expect(firstMax).toBe(true);
    expect(grade!.status).toBe("REQUIRES_REVIEW");
  });

  it("rejects invented criterion ids and invalid schema (no invented criteria)", async () => {
    const sub = await prisma.examSubmission.findFirstOrThrow({ where: { examId, studentId } });
    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId }, include: { questions: true } });
    const writing = exam.questions.find((q) => q.type === "WRITING")!;
    const before = await prisma.writingQuestionGrade.count({ where: { submissionId: sub.id, questionId: writing.id } });

    await prisma.answer.update({
      where: { submissionId_questionId: { submissionId: sub.id, questionId: writing.id } },
      data: { text: "##INJECT_UNKNOWN_CRIT real answer about forces and momentum with labeled evidence net force" },
    });
    await regradeQuestion(sub.id, writing.id, facultyId, "unknown criterion test");
    const grade = await latestGrade(sub.id, writing.id);
    expect(grade!.status).toBe("FAILED"); // rejected twice, flagged for manual grading
    const after = await prisma.writingQuestionGrade.count({ where: { submissionId: sub.id, questionId: writing.id } });
    expect(after).toBe(before + 1); // history preserved — the old rows are intact

    await prisma.answer.update({
      where: { submissionId_questionId: { submissionId: sub.id, questionId: writing.id } },
      data: { text: "##INJECT_INVALID forces answer" },
    });
    await regradeQuestion(sub.id, writing.id, facultyId, "invalid schema test");
    const grade2 = await latestGrade(sub.id, writing.id);
    expect(grade2!.status).toBe("FAILED");
  });

  it("unverifiable (fabricated) evidence is flagged — nothing erased", async () => {
    const sub = await prisma.examSubmission.findFirstOrThrow({ where: { examId, studentId } });
    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId }, include: { questions: true } });
    const writing = exam.questions.filter((q) => q.type === "WRITING")[1];
    await prisma.answer.update({
      where: { submissionId_questionId: { submissionId: sub.id, questionId: writing.id } },
      data: { text: "##INJECT_FAKE_EVIDENCE Answer discussing F equals m a with labeled systematic examples of net force." },
    });
    await regradeQuestion(sub.id, writing.id, facultyId, "fake evidence test");
    const grade = await latestGrade(sub.id, writing.id);
    const criteria = await prisma.criterionGrade.findMany({ where: { gradeId: grade!.id } });
    expect(criteria.some((c) => c.flagged)).toBe(true);
    expect(grade!.status).toBe("REQUIRES_REVIEW");
  });

  it("professor override recorded in GradeAudit with old+new, totals recomputed, release gating works", async () => {
    const sub = await prisma.examSubmission.findFirstOrThrow({ where: { examId, studentId } });
    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId }, include: { questions: true } });
    const writing = exam.questions.find((q) => q.type === "WRITING")!;
    const rubric = await prisma.rubric.findFirstOrThrow({ where: { questionId: writing.id, status: "APPROVED" }, include: { criteria: true } });
    const marks = rubric.criteria.map((c) => ({ criterionId: `criterion_${c.order}`, awardedMarks: Number(c.maxMarks) }));

    const before = await prisma.writingQuestionGrade.count({ where: { submissionId: sub.id, questionId: writing.id } });
    await overrideWritingMarks(sub.id, writing.id, facultyId, marks, "manual review", "found stronger justification");
    const after = await prisma.writingQuestionGrade.count({ where: { submissionId: sub.id, questionId: writing.id } });
    expect(after).toBe(before + 1);

    const audits = await prisma.gradeAudit.findMany({ where: { submissionId: sub.id, action: "PROFESSOR_OVERRIDE" }, orderBy: { createdAt: "desc" } });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const prev = JSON.parse(audits[0].previousJson!);
    expect(typeof prev.awardedMarks).toBe("number"); // original preserved
    expect(audits[0].actorId).toBe(facultyId);

    const submission = await prisma.examSubmission.findUniqueOrThrow({ where: { id: sub.id } });
    expect(submission.totalMarks).toBeGreaterThan(0);

    // student CANNOT see provisional grades
    await expect(getReleasedSubmission(studentId, sub.id)).rejects.toMatchObject({ status: 403 });

    await approveAll(sub.id, facultyId, null);
    await releaseResults(sub.id, facultyId, null);

    // students blocked BEFORE release; visible after
    const released = await getReleasedSubmission(studentId, sub.id);
    expect(released.totalMarks).toBe(submission.totalMarks);
    expect(released.breakdown.some((b) => b.criteria?.length)).toBe(true);

    // release without approval is impossible (new submission state machine)
    const otherSub = await prisma.examSubmission.create({ data: { examId, studentId: (await makeUser("grStudent2", "STUDENT")).id, maxMarks: exam.questions.reduce((a, q) => a + q.marks, 0), status: "PROVISIONAL" } });
    await expect(releaseResults(otherSub.id, facultyId, null)).rejects.toMatchObject({ status: 409 });
  });
});
