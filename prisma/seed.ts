// Demo seed: PHYS-I-61D with a syllabus + three chapter documents (extracted
// text stored directly), faculty + 2 students, an archived lecture.
import { PrismaClient } from "../node_modules/@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const CHAPTERS: Array<{ title: string; text: string }> = [
  {
    title: "Newton's Laws — Net Force",
    text: `Newton's First Law: an object moves at constant velocity unless acted upon by a net external force. The net force is the vector sum of all forces acting on the object.
Newton's Second Law: the acceleration of an object is directly proportional to the net force acting on it and inversely proportional to its mass, expressed mathematically as F = ma. Force is measured in newtons (N), where 1 N = 1 kg·m/s².
Newton's Third Law: for every action there is an equal and opposite reaction. Action-reaction pairs act on different bodies and never cancel each other.
A labeled example: a 4 kg box pushed with 12 N of friction-free steady force accelerates at 3 m/s² because a = F/m = 12/4. If the net force is zero, acceleration is zero even when the object moves.
Free-body diagrams isolate a single object and show each external force as an arrow; only forces acting ON the chosen object belong in the diagram.`,
  },
  {
    title: "Forces in Two Dimensions",
    text: `When forces act in two dimensions, resolve each force into perpendicular components using trigonometry. The net force along each axis is the sum of the components on that axis.
Objects on an incline experience a component of gravity along the slope m g sin(theta) and a perpendicular component m g cos(theta).
Static friction prevents motion up to a maximum F = mu_s N; kinetic friction acts while sliding with F = mu_k N.
Equilibrium occurs when the net force is zero in every direction; objects can be in equilibrium while moving at constant velocity.`,
  },
  {
    title: "Momentum and Collisions",
    text: `Linear momentum p = m v is a conserved quantity for isolated systems. The impulse-momentum theorem states that the impulse of a net force equals the change in momentum.
In elastic collisions both momentum and kinetic energy are conserved; in inelastic collisions momentum is conserved but kinetic energy is not.
A rocket accelerates because expelling mass backwards transfers momentum to the rocket — a practical Third-Law example.`,
  },
];

const SYLLABUS = `Physics I (PHYS-I-61D) — Unit: Newton's Laws. Learning outcomes: state each of Newton's three laws; compute net force and acceleration with F = ma; analyze free-body diagrams; apply momentum conservation. Required readings: chapters listed in the course plan. Closed-book exam format with a multiple-choice section and a written application section.`;

async function main() {
  console.log("Seeding demo data…");
  const hash = await bcrypt.hash("Password!123", 10);

  const professor = await prisma.user.upsert({ where: { email: "professor@university.edu" }, update: {}, create: { email: "professor@university.edu", name: "Dr. Armagan Elibol", passwordHash: hash, role: "FACULTY" } });
  const sara = await prisma.user.upsert({ where: { email: "sara@university.edu" }, update: {}, create: { email: "sara@university.edu", name: "Sara Al Mansoori", passwordHash: hash, role: "STUDENT" } });
  const yousef = await prisma.user.upsert({ where: { email: "yousef@university.edu" }, update: {}, create: { email: "yousef@university.edu", name: "Yousef Al Marzooqi", passwordHash: hash, role: "STUDENT" } });

  const course = await prisma.course.upsert({
    where: { code: "PHYS-I-61D" },
    update: {},
    create: { code: "PHYS-I-61D", title: "Physics I", unit: "Newton's Laws", description: "Mechanics unit — forces, motion, momentum.", professorId: professor.id },
  });

  for (const userId of [sara.id, yousef.id]) {
    await prisma.enrollment.upsert({ where: { courseId_userId: { courseId: course.id, userId } }, update: {}, create: { courseId: course.id, userId } });
  }

  const chapterRows = [];
  for (let i = 0; i < CHAPTERS.length; i++) {
    const existing = await prisma.chapter.findFirst({ where: { courseId: course.id, order: i + 1 } });
    const chapter = existing ?? (await prisma.chapter.create({ data: { courseId: course.id, title: CHAPTERS[i].title, shortId: `ch${i + 1}`, order: i + 1 } }));
    chapterRows.push(chapter);
    const docExists = await prisma.document.findFirst({ where: { courseId: course.id, chapterId: chapter.id } });
    if (!docExists) {
      const doc = await prisma.document.create({
        data: {
          courseId: course.id, chapterId: chapter.id, kind: "CHAPTER",
          title: `Chapter ${i + 1} — ${CHAPTERS[i].title}`,
          originalName: `chapter${i + 1}.md`, filename: `seed-chapter${i + 1}.md`,
          mimeType: "text/markdown", sizeBytes: CHAPTERS[i].text.length,
          status: "PROCESSED", pageCount: 1,
          wordCount: CHAPTERS[i].text.split(/\s+/).length,
          processedAt: new Date(),
        },
      });
      await prisma.documentSegment.createMany({
        data: splitSegments(CHAPTERS[i].text).map((s, ix) => ({ documentId: doc.id, index: ix, heading: null, page: 1, text: s })),
      });
    }
  }

  const syllabusDoc = await prisma.document.findFirst({ where: { courseId: course.id, kind: "SYLLABUS" } });
  if (!syllabusDoc) {
    const doc = await prisma.document.create({
      data: {
        courseId: course.id, kind: "SYLLABUS", title: "PHYS-I-61D Syllabus",
        originalName: "syllabus.md", filename: "seed-syllabus.md",
        mimeType: "text/markdown", sizeBytes: SYLLABUS.length,
        status: "PROCESSED", pageCount: 1, wordCount: SYLLABUS.split(/\s+/).length, processedAt: new Date(),
      },
    });
    await prisma.documentSegment.create({ data: { documentId: doc.id, index: 0, heading: "Syllabus", page: 1, text: SYLLABUS } });
  }

  const lecture = await prisma.lecture.findFirst({ where: { courseId: course.id } });
  if (!lecture) {
    const l = await prisma.lecture.create({
      data: { courseId: course.id, title: "Newton's Laws — Net Force", dateStr: "2026-11-02", status: "ARCHIVED" },
    });
    await prisma.transcriptSegment.createMany({
      data: [
        { lectureId: l.id, seq: 1, offset: "00:00", text: "Today we introduce Newton's three laws and the definition of net force as the vector sum of forces." },
        { lectureId: l.id, seq: 2, offset: "00:32", text: "Second law: F equals m a. Acceleration points along the net force." },
      ],
    });
  }

  console.log("Seed complete:", { professor: professor.email, course: course.code, chapters: chapterRows.length });
}

function splitSegments(text: string, max = 900): string[] {
  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    cur = cur ? cur + "\n\n" + p : p;
    if (cur.length >= max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

main().finally(() => prisma.$disconnect());
