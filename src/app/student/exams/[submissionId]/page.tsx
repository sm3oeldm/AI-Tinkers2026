import { redirect } from "next/navigation";
import { ExamRunner } from "@/components/exam-runner";
import { UserBar } from "@/components/user-bar";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export default async function StudentExamPage({ params }: { params: Promise<{ submissionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "STUDENT") redirect("/faculty");
  const { submissionId } = await params;
  const submission = await prisma.examSubmission.findUnique({ where: { id: submissionId }, select: { studentId: true } });
  if (!submission || submission.studentId !== user.id) redirect("/student");
  return (
    <div>
      <UserBar user={user} left="Student" />
      <div className="title-bar">My courses / <strong>Assessment</strong></div>
      <ExamRunner submissionId={submissionId} />
      <div className="footer">Answers save automatically</div>
    </div>
  );
}
