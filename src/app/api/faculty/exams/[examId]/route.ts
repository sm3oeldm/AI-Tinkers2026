import { NextRequest } from "next/server";
import { checkOrigin, jsonOk, readJson, route } from "@/lib/http";
import { requireOwnedExam, requireFaculty } from "@/lib/access";
import { getFullExam, updateExamMeta } from "@/lib/services/exam-workflow";
import { regenerateDraftQuestion } from "@/lib/services/exam-generation";

/** GET: full draft/published exam for the faculty editor. */
export async function GET(_req: Request, { params }: { params: Promise<{ examId: string }> }) {
  return route(async () => {
    const user = await requireFaculty();
    const { examId } = await params;
    await requireOwnedExam(examId, user);
    return jsonOk({ exam: await getFullExam(examId) });
  });
}

/** PATCH: draft meta (title/description/instructions/duration). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ examId: string }> }) {
  return route(async () => {
    checkOrigin(req);
    const user = await requireFaculty();
    const { examId } = await params;
    await requireOwnedExam(examId, user);
    const body = await readJson<Record<string, unknown>>(req);
    const exam = await updateExamMeta(examId, {
      ...(body.title != null ? { title: String(body.title) } : {}),
      ...(body.description !== undefined ? { description: body.description === null ? null : String(body.description) } : {}),
      ...(body.instructions !== undefined ? { instructions: body.instructions === null ? null : String(body.instructions) } : {}),
      ...(body.durationMinutes != null ? { durationMinutes: Number(body.durationMinutes) } : {}),
    });
    return jsonOk({ exam });
  });
}
