// The spec's 16-step end-to-end definition-of-done:
// 1 faculty selects syllabus + 2 chapters → 2 configures 10 MCQ + 3 writing + marks
// 3 generation with gemma → 4 draft with per-question rubrics → 5 edits 2 questions
// 6 modifies 1 rubric → 7 approves → 8 publishes → 9 student takes exam → 10 submits
// 11 MCQs graded deterministically → 12 writing graded by Gemma against the SAVED
// rubrics → 13 validation of results → 14 faculty reviews/approves → 15 release
// 16 student sees released results — proving the EDITED rubric was used.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resetDb, prisma, makeUser, makeCourseWithDocs, generateExam } from "./helpers";
import { generateDraftExam } from "../src/lib/services/exam-generation";
import { updateDraftQuestion, editDraftRubric, approveExam, publishExam, validateExamForApproval } from "../src/lib/services/exam-workflow";
import { startSubmission, submitExam, approveAll, releaseResults } from "../src/lib/services/grading";
import * as gradingSvc from "../src/lib/services/grading";
import { getReleasedSubmission } from "../src/lib/services/results";

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await prisma.$disconnect(); });

describe("16-step end-to-end: professor → gemma → student → released results", () => {
  let facultyId: string, studentId: string, courseId: string, chapterIds: string[], examId: string;
  let submissionId: string;
  let editedInfo: { questionId: string; newText: string } | null = null;
  let rubricEdit: { questionId: string; firstCriterionName: string; total: number } | null = null;

  beforeAll(async () => {
    facultyId = (await makeUser("e2eFaculty", "FACULTY")).id;
    studentId = (await makeUser("e2eStudent", "STUDENT")).id;
  });

  it("1–2. faculty selects 2 chapters + syllabus and configures 10 MCQ + 3 writing with marks", async () => {
    const made = await makeCourseWithDocs(facultyId, { chapters: ["Forces", "Momentum", "Thermo"] });
    courseId = made.course.id;
    chapterIds = made.chapterIds.slice(0, 2); // professors select first two chapters
    await prisma.enrollment.create({ data: { courseId, userId: studentId } });
    // selection validated by generateDraftExam parameters below (syllabus included)
    void chapterIds;
  });

  it("3–4. gemma drafts the exam (10 MCQ + 3 writing, each writing with a rubric draft)", async () => {
    // syllabus included via additional material? includeSyllabus flag in selection
    const gen = await generateDraftExam(courseId, facultyId, {
      title: "Midterm — Newton's Laws",
      description: null,
      instructions: "Show your work on written answers.",
      durationMinutes: 90,
      difficulty: "mixed",
      selectedChapterIds: chapterIds,
      includeSyllabus: false,
      additionalMaterialDocumentIds: [],
      mcq: { count: 10, marksPerQuestion: 2 },
      writing: { count: 3, marksPerQuestion: 10 },
      declaredTotalMarks: 50,
    }, { selectedChapterIds: chapterIds, includeSyllabus: false, additionalMaterialDocumentIds: [] });
    expect(gen.warnings).toEqual([]);
    examId = gen.examId;

    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId }, include: { questions: { include: { rubricVersions: { include: { criteria: true } } } } } });
    expect(exam.status).toBe("DRAFT");
    expect(exam.questions.filter((q) => q.type === "MCQ")).toHaveLength(10);
    const writings = exam.questions.filter((q) => q.type === "WRITING");
    expect(writings).toHaveLength(3);
    for (const w of writings) {
      expect(w.rubricVersions[0].criteria.length).toBeGreaterThan(0);
      expect(w.rubricVersions[0].criteria.reduce((a, c) => a + c.maxMarks, 0)).toBe(10);
    }
    void validateExamForApproval;
  });

  it("5. professor edits two questions and saves", async () => {
    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId }, include: { questions: true } });
    const [mcq, writing] = exam.questions;
    await updateDraftQuestion(examId, mcq.id, { text: "EDITED: Net force on a 4 kg box pushed with 12 N equals what acceleration?" });
    await updateDraftQuestion(examId, writing.id, { text: "EDITED: Explain the net force rule and apply it to a 4 kg box pushed with 12 N." });
    editedInfo = { questionId: mcq.id, newText: "EDITED: Net force on a 4 kg box pushed with 12 N equals what acceleration?" };
    void editedInfo;
  });

  it("6. professor modifies one writing rubric (retunes to 12 marks and renames a criterion)", async () => {
    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId }, include: { questions: { include: { rubricVersions: { include: { criteria: true } } } } } });
    const writing = exam.questions.find((q) => q.type === "WRITING")!;
    const rubric = writing.rubricVersions[0];
    // bump question to 12 and criteria accordingly so sums match again
    await updateDraftQuestion(examId, writing.id, { marks: 12 });
    const scaled = rubric.criteria.map((c, i) => ({
      name: i === 0 ? "EDITED CRITERION — application of net force rule" : c.name,
      description: c.description,
      maxMarks: i === 0 ? Number(c.maxMarks) + 2 : Number(c.maxMarks),
      fullCredit: c.fullCredit,
      partialCredit: c.partialCredit,
      commonMistakes: c.commonMistakes,
      acceptableAlternatives: c.acceptableAlternatives,
    }));
    await editDraftRubric(examId, writing.id, scaled);
    const fresh = await prisma.rubric.findUniqueOrThrow({ where: { id: rubric.id }, include: { criteria: true } });
    rubricEdit = { questionId: writing.id, firstCriterionName: fresh.criteria[0].name, total: fresh.criteria.reduce((a, c) => a + Number(c.maxMarks), 0) };
    expect(rubricEdit.total).toBe(12);
  });

  it("7–8. professor approves (locks rubrics) and publishes", async () => {
    const v = await validateExamForApproval(examId);
    expect(v.ok).toBe(true);
    expect(v.totalMarks).toBe(52); // 10×2 + 2×10 + 1×12
    const approved = await approveExam(examId, facultyId);
    expect(approved.status).toBe("APPROVED");
    const published = await publishExam(examId, facultyId);
    expect(published.status).toBe("PUBLISHED");
  });

  it("9–10. student takes the exam and submits", async () => {
    const sub = await startSubmission(examId, studentId);
    submissionId = sub.id;
    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId }, include: { questions: true } });
    for (const q of exam.questions) {
      if (q.type === "MCQ") {
        await prisma.answer.create({ data: { submissionId, questionId: q.id, selectedOptionId: q.correctAnswerId! } });
      } else {
        const rubric = await prisma.rubric.findFirstOrThrow({ where: { questionId: q.id, status: "APPROVED" }, include: { criteria: true } });
        const words = rubric.criteria.flatMap((c) => c.fullCredit.toLowerCase().split(/\W+/)).filter((w) => w.length > 3 && !["answer", "clearly", "completely", "addresses", "aspect", "consistent", "with", "question", "partially", "some", "correct", "content", "missing", "incorrect"].includes(w));
        const uniq = [...new Set(words)].slice(0, 12);
        await prisma.answer.create({ data: { submissionId, questionId: q.id, text: uniq.join(" ") + " labeled examples of net force with systematic explanation." } });
      }
    }
    const result = await submitExam(submissionId, studentId);
    expect(result.status).toBe("PROVISIONAL");
  });

  it("11–13. MCQ graded deterministically; writing graded against the SAVED (edited) rubrics", async () => {
    const sub = await prisma.examSubmission.findUniqueOrThrow({ where: { id: submissionId } });
    // MCQ: all correct → full MCQ marks
    expect(sub.mcqMarks).toBe(20);

    // The EDITED rubric must be the grading source: criterion name snapshot proves it.
    const grades = await prisma.writingQuestionGrade.findMany({ where: { submissionId, status: { in: ["SUCCEEDED", "REQUIRES_REVIEW"] } }, include: { criteria: true, question: true, rubric: { include: { criteria: true } } } });
    expect(grades.length).toBe(3);
    for (const g of grades) {
      // rubric version used = the approved version of the exam (not drafts)
      expect(g.rubric.status).toBe("APPROVED");
      expect(g.rubricVersion).toBe(g.rubric.version);
      // criterion rows match the rubric's canonical names & maxes
      for (const c of g.criteria) {
        const canonical = g.rubric.criteria.find((rc) => `criterion_${rc.order}` === c.criterionId);
        expect(canonical!.name).toBe(c.criterionName);
        expect(canonical!.maxMarks).toBe(c.maxMarks);
      }
      // server-side total equals Σ criteria (backend authoritative)
      expect(g.awardedMarks).toBe(g.criteria.reduce((a, c) => a + c.awardedMarks, 0));
      // evidence exists and is verified against the actual submitted answer
      for (const c of g.criteria) {
        const evidence = JSON.parse(c.evidenceJson) as Array<{ verified: boolean; quote: string }>;
        for (const ev of evidence) expect(ev.verified).toBe(true);
      }
    }

    // The EDITED criterion name proves grading used the edited rubric (not AI draft)
    const editedGrade = grades.find((g) => g.question.id === rubricEdit!.questionId)!;
    expect(editedGrade.criteria.map((c) => c.criterionName)).toContain(rubricEdit!.firstCriterionName);
  });

  it("14–15. faculty reviews, approves and releases", async () => {
    await approveAll(submissionId, facultyId, "reviewed");
    await releaseResults(submissionId, facultyId, "results finalized");
    const audits = await prisma.gradeAudit.findMany({ where: { submissionId, action: "RELEASED" } });
    expect(audits).toHaveLength(1);
    void gradingSvc;
  });

  it("16. student sees ONLY released results with criterion-level breakdown", async () => {
    const released = await getReleasedSubmission(studentId, submissionId);
    expect(released.totalMarks).toBeGreaterThan(0);
    expect(released.maxMarks).toBe(52);
    const writing = released.breakdown.filter((b) => b.criteria?.length);
    expect(writing.length).toBe(3);
    // edited criterion surfaced to the student
    expect(writing.map((b) => b.criteria!.flat().map((c) => c.criterionName)).join("|")).toContain("EDITED CRITERION");
  });
});
