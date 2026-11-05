import { NextRequest } from "next/server";
import { checkOrigin, jsonOk, route } from "@/lib/http";
import { requireStudent } from "@/lib/access";
import { listReleasedResults, getReleasedSubmission } from "@/lib/services/results";

/** GET: released results only. Provisional grades are structurally unreachable. */
export async function GET(req: NextRequest) {
  return route(async () => {
    const user = await requireStudent();
    const submissionId = req.nextUrl.searchParams.get("submissionId");
    if (submissionId) {
      return jsonOk({ submission: await getReleasedSubmission(user.id, submissionId) });
    }
    const courseId = req.nextUrl.searchParams.get("courseId") ?? undefined;
    return jsonOk({ results: await listReleasedResults(user.id, courseId) });
  });
}
