import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resetDb, prisma, makeUser, makeCourseWithDocs, generateExam } from "./helpers";
import { approveExam, publishExam, validateExamForApproval, editDraftRubric, updateDraftQuestion } from "../src/lib/services/exam-workflow";
import { ApiError } from "../src/lib/http";

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await prisma.$disconnect(); });

describe("Exam workflow: validation, approval, publish", () => {
  let facultyId: string;
  let courseId: string;
  let chapterIds: string[];
  let examId: string;

  beforeAll(async () => {
    facultyId = (await makeUser("wfFaculty", "FACULTY")).id;
    const made = await makeCourseWithDocs(facultyId, { chapters: ["Forces", "Momentum"] });
    courseId = made.course.id;
    chapterIds = made.chapterIds;
    const gen = await generateExam(courseId, facultyId, chapterIds, {
      mcq: { count: 2, marksPerQuestion: 2 },
      writing: { count: 2, marksPerQuestion: 10 },
    });
    examId = gen.examId;
  });

  it("validation passes for a sound draft", async () => {
    const v = await validateExamForApproval(examId);
    expect(v.ok).toBe(true);
    expect(v.totalMarks).toBe(24);
  });

  it("blocks approval when a rubric no longer sums to question marks", async () => {
    const exam = await prisma.exam.findUnique({ where: { id: examId }, include: { questions: true } });
    const writing = exam!.questions.find((q) => q.type === "WRITING")!;
    await updateDraftQuestion(examId, writing.id, { marks: 12 }); // rubric still sums to 10
    const v = await validateExamForApproval(examId);
    expect(v.ok).toBe(false);
    expect(v.issues.join(" ")).toMatch(/must equal the question marks/);
    await expect(approveExam(examId, facultyId)).rejects.toMatchObject({ status: 422 });
  });

  it("faculty can edit the draft rubric to restore validity, then approve + publish", async () => {
    const exam = await prisma.exam.findUnique({ where: { id: examId }, include: { questions: true } });
    const writing = exam!.questions.find((q) => q.type === "WRITING")!;
    const rubric = await prisma.rubric.findFirst({ where: { questionId: writing.id }, include: { criteria: true } });
    // Retune to exactly 12: scale first criterion up by 2.
    const patch = rubric!.criteria.map((c, i) => ({
      name: c.name,
      description: c.description,
      maxMarks: i === 0 ? Number(c.maxMarks) + 2 : Number(c.maxMarks),
      fullCredit: c.fullCredit,
      partialCredit: c.partialCredit,
      commonMistakes: c.commonMistakes,
      acceptableAlternatives: c.acceptableAlternatives,
    }));
    await editDraftRubric(examId, writing.id, patch as never);

    const approved = await approveExam(examId, facultyId);
    expect(approved.status).toBe("APPROVED");

    // rubrics are now APPROVED (immutable versions)
    const frozen = await prisma.rubric.findFirst({ where: { questionId: writing.id }, include: { criteria: true } });
    expect(frozen!.status).toBe("APPROVED");
    expect(frozen!.criteria.reduce((a, c) => a + c.maxMarks, 0)).toBe(12);

    const published = await publishExam(examId, facultyId);
    expect(published.status).toBe("PUBLISHED");
  });

  it("draft-after-approval rubric edits are rejected (immutable approved rubric)", async () => {
    const exam = await prisma.exam.findUnique({ where: { id: examId }, include: { questions: true } });
    const writing = exam!.questions.find((q) => q.type === "WRITING")!;
    await expect(
      editDraftRubric(examId, writing.id, [] as never)
    ).rejects.toMatchObject({ status: 409 });
  });

  it("non-owner faculty cannot approve someone else's exam", async () => {
    const otherFaculty = await makeUser("wfFaculty2", "FACULTY");
    const made = await makeCourseWithDocs(facultyId, { chapters: ["Forces"] });
    const gen = await generateExam(made.course.id, facultyId, made.chapterIds, { mcq: { count: 1, marksPerQuestion: 1 }, writing: { count: 0, marksPerQuestion: 1 } });
    await expect(approveExam(gen.examId, otherFaculty.id)).rejects.toMatchObject({ status: 403 });
    void otherFaculty; void ApiError;
  });
});
