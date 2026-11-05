import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { UserBar } from "@/components/user-bar";
import { MaterialPanel } from "@/components/material-panel";
import { ExamWizard } from "@/components/exam-wizard";

export default async function FacultyCoursePage({ params }: { params: Promise<{ courseId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "FACULTY") redirect("/student");
  const { courseId } = await params;
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course || course.professorId !== user.id) redirect("/faculty");

  const exams = await prisma.exam.findMany({
    where: { courseId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { questions: true, submissions: true } } },
  });
  const chapters = await prisma.chapter.findMany({ where: { courseId }, orderBy: { order: "asc" } });
  const docs = await prisma.document.findMany({ where: { courseId }, orderBy: { createdAt: "desc" } });

  return (
    <div>
      <UserBar user={user} left="Faculty" />
      <div className="title-bar">Dashboard / My courses / <strong>{course.code}</strong> / Faculty tools</div>
      <div className="course-hero">
        <h1>{course.title} — Faculty view</h1>
        <div>
          <a className="pill-btn ghost" href="/faculty">← My courses</a>
        </div>
      </div>
      <div className="layout">
        <div className="side">
          <div className="block">
            <div className="block-head">Navigation</div>
            <div className="block-body"><ul><li><a href="/faculty">My courses</a></li><li><strong>{course.code}</strong></li></ul></div>
          </div>
        </div>
        <div className="main">
          <ExamWizard courseId={courseId} chapters={chapters} docs={docs} onDone={() => {}} />
          <div className="activity">
            <div className="activity-head"><h3>Exams</h3></div>
            <div className="activity-body">
              <table className="plain">
                <thead><tr><th>Title</th><th>Status</th><th>Questions</th><th>Submissions</th><th></th></tr></thead>
                <tbody>
                  {exams.map((x) => (
                    <tr key={x.id}>
                      <td>{x.title} {x.isAiGenerated && <span className="chip">AI draft</span>}</td>
                      <td><span className={`status-badge ${x.status}`}>{x.status}</span></td>
                      <td>{x._count.questions}</td>
                      <td>{x._count.submissions}</td>
                      <td>
                        <a className="pill-btn ghost" href={`/faculty/${courseId}/exams/${x.id}`}>Open editor</a>{" "}
                        <a className="pill-btn secondary" href={`/faculty/${courseId}/grading/${x.id}`}>Grading</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {exams.length === 0 && <p className="hint">No exams yet — generate your first AI draft above.</p>}
            </div>
          </div>
          <MaterialPanel courseId={courseId} />
        </div>
      </div>
      <div className="footer">Al Ain University — Course Companion faculty area</div>
    </div>
  );
}
