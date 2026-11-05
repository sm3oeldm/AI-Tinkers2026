import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";
import { generateDraftExam } from "../src/lib/services/exam-generation";
import { examConfigSchema } from "../src/lib/validation";
import type { ExamConfig } from "../src/lib/validation";

export async function resetDb() {
  // Order matters for FK-less SQLite deletes: children first.
  await prisma.gradeAudit.deleteMany();
  await prisma.criterionGrade.deleteMany();
  await prisma.writingQuestionGrade.deleteMany();
  await prisma.answer.deleteMany();
  await prisma.examSubmission.deleteMany();
  await prisma.rubricCriterion.deleteMany();
  await prisma.rubric.deleteMany();
  await prisma.examQuestion.deleteMany();
  await prisma.exam.deleteMany();
  await prisma.documentSegment.deleteMany();
  await prisma.document.deleteMany();
  await prisma.lecture.deleteMany();
  await prisma.discussionTopics.deleteMany();
  await prisma.enrollment.deleteMany();
  await prisma.chapter.deleteMany();
  await prisma.session.deleteMany();
  await prisma.course.deleteMany();
  await prisma.user.deleteMany();
}

export async function makeUser(name: string, role: "FACULTY" | "STUDENT") {
  return prisma.user.create({ data: { email: `${name.toLowerCase()}@t.example`, name, role, passwordHash: await hashPassword("Password!123") } });
}

export async function makeCourseWithDocs(facultyId: string, opts?: { chapters?: string[]; students?: number }) {
  const course = await prisma.course.create({ data: { code: `T-${Math.random().toString(36).slice(2, 8)}`, title: "Test Course", professorId: facultyId } });
  const chapters = opts?.chapters ?? ["Forces", "Momentum", "Thermo"];
  const chapterIds: string[] = [];
  for (let i = 0; i < chapters.length; i++) {
    const ch = await prisma.chapter.create({ data: { courseId: course.id, title: chapters[i], shortId: `ch${i + 1}`, order: i + 1 } });
    chapterIds.push(ch.id);
    // The student answer for fake-evidence tests includes this marker.
    const marker = `MARKER_${chapters[i].toUpperCase().replace(/[^A-Z]/g, "")}`;
    const body = `${marker} intro. The laws of ${chapters[i]} state that central quantities conserve and forces produce proportional acceleration according to F equals m a. ${marker} details explain labeled experiments and net force rules.`;
    const doc = await prisma.document.create({
      data: {
        courseId: course.id, chapterId: ch.id, kind: "CHAPTER",
        title: `Chapter ${i + 1} — ${chapters[i]}`, originalName: "c.md", filename: "c.md",
        mimeType: "text/markdown", sizeBytes: body.length, status: "PROCESSED", pageCount: 1, processedAt: new Date(),
      },
    });
    await prisma.documentSegment.create({ data: { documentId: doc.id, index: 0, heading: chapters[i], page: 1, text: body } });
  }
  if (opts?.students) {
    for (let i = 0; i < opts.students; i++) {
      const s = await makeUser(`student${i}`, "STUDENT");
      await prisma.enrollment.create({ data: { courseId: course.id, userId: s.id } });
    }
  }
  return { course, chapterIds };
}

const base = {
  title: "Generated exam",
  durationMinutes: 60,
  difficulty: "mixed" as const,
  instructions: null as string | null,
  declaredTotalMarks: null as number | null,
};

export function makeConfig(cfg: Partial<ExamConfig> = {}): ExamConfig {
  return examConfigSchema.parse({
    ...base,
    mcq: cfg.mcq ?? { count: 0, marksPerQuestion: 2 },
    writing: cfg.writing ?? { count: 0, marksPerQuestion: 10 },
    ...cfg,
  });
}

export async function generateExam(courseId: string, facultyId: string, chapterIds: string[], cfg: Partial<ExamConfig> = {}) {
  const result = await generateDraftExam(courseId, facultyId, makeConfig({ ...cfg, selectedChapterIds: cfg.selectedChapterIds ?? chapterIds }), {
    selectedChapterIds: cfg.selectedChapterIds ?? chapterIds,
    includeSyllabus: false,
    additionalMaterialDocumentIds: [],
  });
  return { ...result };
}

export { prisma };
