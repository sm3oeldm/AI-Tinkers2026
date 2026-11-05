import { redirect } from "next/navigation";
import { StudentCourse } from "@/components/student-course";
import { UserBar } from "@/components/user-bar";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export default async function StudentCoursePage({ params }: { params: Promise<{ courseId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "STUDENT") redirect("/faculty");
  const { courseId } = await params;
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course) redirect("/student");
  return (
    <div>
      <UserBar user={user} left="Student" />
      <div className="title-bar">Dashboard / My courses / <strong>{course.code}</strong></div>
      <div className="course-hero">
        <h1>{course.title}</h1>
        <div><a className="pill-btn ghost" href="/student">← My courses</a></div>
      </div>
      <StudentCourse courseId={courseId} />
      <div className="footer">Al Ain University — Course Companion</div>
    </div>
  );
}
