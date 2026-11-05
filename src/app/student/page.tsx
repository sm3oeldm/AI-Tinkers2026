import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { UserBar } from "@/components/user-bar";

export default async function StudentHome() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "STUDENT") redirect("/faculty");
  const enrollments = await prisma.enrollment.findMany({
    where: { userId: user.id },
    include: { course: { include: { exams: { where: { status: "PUBLISHED" } } } } },
  });
  return (
    <div>
      <UserBar user={user} left="Student" />
      <div className="title-bar">Dashboard / My courses / <strong>{user.name}</strong></div>
      <div className="course-hero"><h1>My courses</h1></div>
      <div className="layout">
        <div className="side">
          <div className="block">
            <div className="block-head">Navigation</div>
            <div className="block-body"><ul><li><a href="/login">Switch account</a></li></ul></div>
          </div>
        </div>
        <div className="main">
          {enrollments.map((e) => (
            <div className="activity" key={e.course.id}>
              <div className="activity-head"><h3><a href={`/student/${e.course.id}`}>{e.course.code} — {e.course.title}</a></h3>
                <span className="hint">{e.course.exams.length} published exams</span></div>
              <div className="activity-body"><p className="hint">{e.course.description ?? "Open the course to take exams and see released results."}</p></div>
            </div>
          ))}
        </div>
      </div>
      <div className="footer">Al Ain University — Course Companion</div>
    </div>
  );
}
