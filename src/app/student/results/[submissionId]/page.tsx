import { redirect } from "next/navigation";
import { StudentResults } from "@/components/student-results";
import { UserBar } from "@/components/user-bar";
import { getCurrentUser } from "@/lib/auth";

export default async function StudentResultsPage({ params }: { params: Promise<{ submissionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "STUDENT") redirect("/faculty");
  const { submissionId } = await params;
  return (
    <div>
      <UserBar user={user} left="Student" />
      <div className="title-bar">My courses / <strong>Results</strong></div>
      <StudentResults submissionId={submissionId} />
      <div className="footer">Released results only</div>
    </div>
  );
}
