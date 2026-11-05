import { NextRequest } from "next/server";
import { checkOrigin, jsonOk, readJson, route } from "@/lib/http";
import { requireStudent } from "@/lib/access";
import { saveAnswer, submitExam } from "@/lib/services/grading";

/** PUT: save one answer { questionId, selectedOptionId?, text? } */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ submissionId: string }> }) {
  return route(async () => {
    checkOrigin(req);
    const user = await requireStudent();
    const { submissionId } = await params;
    const body = await readJson<{ questionId?: string; selectedOptionId?: string | null; text?: string | null }>(req);
    if (!body.questionId) return jsonOk({ error: "questionId required" }, 400);
    await saveAnswer(submissionId, user.id, {
      questionId: body.questionId,
      selectedOptionId: body.selectedOptionId ?? null,
      text: body.text ?? null,
    });
    return jsonOk({ saved: true });
  });
}

/** POST: submit + trigger the automatic grading pipeline (idempotent). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ submissionId: string }> }) {
  return route(async () => {
    checkOrigin(req);
    const user = await requireStudent();
    const { submissionId } = await params;
    const result = await submitExam(submissionId, user.id);
    return jsonOk(result);
  });
}
