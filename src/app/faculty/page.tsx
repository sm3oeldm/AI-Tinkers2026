import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { UserBar } from "@/components/user-bar";

export default async function FacultyHome() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "FACULTY") redirect("/student");
  const courses = await prisma.course.findMany({
    where: { professorId: user.id },
    include: { _count: { select: { exams: true, documents: true, enrollments: true } } },
  });
  return (
    <div>
      <UserBar user={user} left="Faculty" />
      <div className="title-bar">Dashboard / My courses / <strong>{user.name}</strong></div>
      <div className="course-hero"><h1>My courses — Faculty view</h1></div>
      <div className="layout">
        <div className="side">
          <div className="block">
            <div className="block-head">Navigation</div>
            <div className="block-body">
              <ul><li><a href="#">Dashboard</a></li><li><strong>My courses</strong></li></ul>
            </div>
          </div>
        </div>
        <div className="main">
          {courses.map((c) => (
            <div className="activity" key={c.id}>
              <div className="activity-head"><h3><a href={`/faculty/${c.id}`}>{c.code} — {c.title}</a></h3>
                <span className="hint">{c._count.exams} exams · {c._count.documents} documents · {c._count.enrollments} students</span>
              </div>
              <div className="activity-body"><p className="hint">{c.description ?? "Course Companion teaching tools"}</p></div>
            </div>
          ))}
          {courses.length === 0 && <div className="callout">No courses yet — create one from a seeded demo or add chapters + uploads.</div>}
        </div>
      </div>
      <div className="footer">Al Ain University — Course Companion faculty area (production build)</div>
    </div>
  );
}
