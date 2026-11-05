import { NextRequest } from "next/server";
import { checkOrigin, jsonOk, readJson, route } from "@/lib/http";
import { requireOwnedExam, requireFaculty } from "@/lib/access";
import { deleteDraftQuestion, updateDraftQuestion, editDraftRubric } from "@/lib/services/exam-workflow";
import { rubricPatchSchema } from "@/lib/validation";

/** PATCH /api/faculty/exams/[examId]/questions/[questionId]
 * body: either question patch (text/marks/options/correctAnswerId/expectedAnswer)
 * or { rubric: { criteria: [...] } } to replace draft rubric criteria.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ examId: string; questionId: string }> }) {
  return route(async () => {
    checkOrigin(req);
    const user = await requireFaculty();
    const { examId, questionId } = await params;
    await requireOwnedExam(examId, user);
    const body = await readJson<Record<string, unknown>>(req);

    if (body.rubric) {
      const parsed = rubricPatchSchema.safeParse(body.rubric);
      if (!parsed.success) {
        return jsonOk({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
      }
      const rubric = await editDraftRubric(examId, questionId, parsed.data.criteria);
      return jsonOk({ rubric });
    }

    const question = await updateDraftQuestion(examId, questionId, body);
    return jsonOk({ question });
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ examId: string; questionId: string }> }) {
  return route(async () => {
    checkOrigin(req);
    const user = await requireFaculty();
    const { examId, questionId } = await params;
    await requireOwnedExam(examId, user);
    await deleteDraftQuestion(examId, questionId);
    return jsonOk({ ok: true });
  });
}
