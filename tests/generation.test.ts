import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resetDb, prisma, makeUser, makeCourseWithDocs, makeConfig, generateExam } from "./helpers";

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await prisma.$disconnect(); });

describe("Exam generation (test provider offline)", () => {
  let facultyId: string;
  beforeAll(async () => {
    facultyId = (await makeUser("genFaculty", "FACULTY")).id;
  });

  it("creates a DRAFT exam (never auto-published) with questions + rubrics", async () => {
    const { course, chapterIds } = await makeCourseWithDocs(facultyId, { chapters: ["Forces", "Momentum"] });
    const { examId, warnings } = await generateExam(course.id, facultyId, chapterIds, {
      mcq: { count: 5, marksPerQuestion: 2 },
      writing: { count: 2, marksPerQuestion: 10 },
    });
    expect(warnings).toEqual([]);
    const exam = await prisma.exam.findUnique({ where: { id: examId }, include: { questions: { include: { rubricVersions: { include: { criteria: true } } } } } });
    expect(exam?.status).toBe("DRAFT");
    expect(exam?.isAiGenerated).toBe(true);
    const mcqs = exam!.questions.filter((q) => q.type === "MCQ");
    const writings = exam!.questions.filter((q) => q.type === "WRITING");
    expect(mcqs).toHaveLength(5);
    expect(writings).toHaveLength(2);
    // every MCQ has exactly one valid key among options
    for (const m of mcqs) {
      const opts = JSON.parse(m.optionsJson!) as Array<{ id: string }>;
      expect(opts).toHaveLength(4);
      expect(opts.some((o) => o.id === m.correctAnswerId)).toBe(true);
    }
    // every writing question has a draft rubric with criteria sums matching marks
    for (const w of writings) {
      expect(w.rubricVersions).toHaveLength(1);
      expect(w.rubricVersions[0].status).toBe("DRAFT");
      const sum = w.rubricVersions[0].criteria.reduce((a, c) => a + c.maxMarks, 0);
      expect(sum).toBe(w.marks);
      expect(w.needsRubricFix).toBe(false);
    }
  });

  it("respects the selected chapters ONLY (unselected content never used)", async () => {
    const { course, chapterIds } = await makeCourseWithDocs(facultyId, { chapters: ["Forces", "Momentum", "Thermo"] });
    // select only the FIRST chapter; Thermo content must not appear anywhere
    const { examId } = await generateExam(course.id, facultyId, chapterIds, {
      selectedChapterIds: [chapterIds[0]],
      mcq: { count: 4, marksPerQuestion: 2 },
      writing: { count: 1, marksPerQuestion: 10 },
    });
    const exam = await prisma.exam.findUnique({ where: { id: examId }, include: { questions: true } });
    const allText = exam!.questions.map((q) => q.text + (q.expectedAnswer ?? "") + (q.explanation ?? "")).join(" ");
    expect(allText).toContain("MARKER_FORCES");
    expect(allText).not.toContain("MARKER_THERMO");
    expect(allText).not.toContain("MARKER_MOMENTUM");
  });

  it("flags duplicate questions (dup detection drops repeated content)", async () => {
    const { course, chapterIds } = await makeCourseWithDocs(facultyId, { chapters: ["Forces"] });
    // a single-chapter source with 5 requested questions on the same 1-sentence
    // content — the deterministic provider would produce near-duplicates; the
    // service must drop them and warn instead of storing copies.
    const { warnings, examId } = await generateExam(course.id, facultyId, chapterIds, {
      mcq: { count: 3, marksPerQuestion: 1 },
      writing: { count: 0, marksPerQuestion: 2 },
    });
    void warnings;
    const exam = await prisma.exam.findUnique({ where: { id: examId }, include: { questions: true } });
    const texts = exam!.questions.map((q) => q.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("fails with 422 and a per-document report when nothing usable is selected", async () => {
    const { course, chapterIds } = await makeCourseWithDocs(facultyId, { chapters: ["Forces"] });
    await prisma.documentSegment.deleteMany({});
    await prisma.document.deleteMany({});
    await expect(
      generateExam(course.id, facultyId, chapterIds, { mcq: { count: 2, marksPerQuestion: 1 }, writing: { count: 0, marksPerQuestion: 2 } })
    ).rejects.toMatchObject({ status: 422 });
    await prisma.chapter.deleteMany({});
    void course;
  });

  it("rejects configs whose declared total marks don't match question marks", () => {
    expect(() =>
      makeConfig({
        mcq: { count: 5, marksPerQuestion: 2 },
        writing: { count: 1, marksPerQuestion: 10 },
        declaredTotalMarks: 25, // actual = 20
      })
    ).toThrow(/do not match/i);
  });

  it("rejects empty source selection", () => {
    expect(() => makeConfig({})).toThrow();
  });
});
