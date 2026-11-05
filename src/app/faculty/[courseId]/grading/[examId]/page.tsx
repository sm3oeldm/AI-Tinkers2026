import { UserBar } from "@/components/user-bar";
import GradingBoard from "@/components/grading-board";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { redirect } from "next/navigation";

export default async function FacultyGradingPage({ params }: { params: Promise<{ courseId: string; examId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "FACULTY") redirect("/student");
  const { courseId, examId } = await params;
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course || course.professorId !== user.id) redirect("/faculty");
  return (
    <div>
      <UserBar user={user} left="Faculty" />
      <div className="title-bar">Dashboard / My courses / <strong>{course.code}</strong> / Grading review</div>
      <div className="layout">
        <div className="main" style={{ padding: 0 }}>
          <GradingBoard examId={examId} courseId={courseId} />
        </div>
      </div>
      <div className="footer">Every show/hide, override and release is recorded in the grade audit trail</div>
    </div>
  );
}
