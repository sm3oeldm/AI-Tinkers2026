import { NextRequest } from "next/server";
import { checkOrigin, jsonOk, readJson, route } from "@/lib/http";
import { requireStudent } from "@/lib/access";
import { startSubmission } from "@/lib/services/grading";

/** POST: start a submission (examId in body). */
export async function POST(req: NextRequest) {
  return route(async () => {
    checkOrigin(req);
    const user = await requireStudent();
    const body = await readJson<{ examId?: string }>(req);
    if (!body.examId) return jsonOk({ error: "examId required" }, 400);
    const submission = await startSubmission(body.examId, user.id);
    return jsonOk({ submission: { id: submission.id, status: submission.status } }, 201);
  });
}
