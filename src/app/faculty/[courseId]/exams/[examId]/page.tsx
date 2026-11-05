import { ExamEditor } from "@/components/exam-editor";
import { UserBar } from "@/components/user-bar";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { redirect } from "next/navigation";

export default async function FacultyExamEditorPage({ params }: { params: Promise<{ courseId: string; examId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "FACULTY") redirect("/student");
  const { courseId, examId } = await params;
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course || course.professorId !== user.id) redirect("/faculty");
  return (
    <div>
      <UserBar user={user} left="Faculty" />
      <div className="title-bar">Dashboard / My courses / <strong>{course.code}</strong> / Exam draft editor</div>
      <div className="layout">
        <div className="side">
          <div className="block"><div className="block-head">Editor</div><div className="block-body"><ul><li><a href={`/faculty/${courseId}`}>← Back to course</a></li></ul></div></div>
        </div>
        <div className="main"><ExamEditor courseId={courseId} examId={examId} /></div>
      </div>
      <div className="footer">Draft editing — approve only after every rubric matches</div>
    </div>
  );
}
