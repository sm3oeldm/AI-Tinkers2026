import { NextRequest } from "next/server";
import { checkOrigin, jsonOk, readJson, route } from "@/lib/http";
import { requireOwnedExam, requireFaculty } from "@/lib/access";
import { approveExam, publishExam, validateExamForApproval, addDraftQuestion, reorderQuestions } from "@/lib/services/exam-workflow";
import { regenerateDraftQuestion } from "@/lib/services/exam-generation";
import { prisma } from "@/lib/db";

/** POST /api/faculty/exams/[examId]/actions
 * body: { action: "approve" | "publish" | "validate" | "regenerate", questionId? , question? }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ examId: string }> }) {
  return route(async () => {
    checkOrigin(req);
    const user = await requireFaculty();
    const { examId } = await params;
    await requireOwnedExam(examId, user);
    const body = await readJson<{ action: string; questionId?: string; questionIds?: string[]; question?: Record<string, unknown> }>(req);

    switch (body.action) {
      case "validate":
        return jsonOk(await validateExamForApproval(examId));
      case "approve": {
        const exam = await approveExam(examId, user.id);
        return jsonOk({ exam });
      }
      case "publish": {
        const exam = await publishExam(examId, user.id);
        return jsonOk({ exam });
      }
      case "regenerate": {
        if (!body.questionId) return jsonOk({ error: "questionId required" }, 400);
        const out = await regenerateDraftQuestion(examId, body.questionId, user.id);
        return jsonOk(out);
      }
      case "add_question": {
        const q = body.question as never;
        const created = await addDraftQuestion(examId, q);
        return jsonOk({ question: created }, 201);
      }
      case "reorder": {
        await reorderQuestions(examId, (body.questionIds as string[]) ?? []);
        return jsonOk({ ok: true });
      }
      default:
        return jsonOk({ error: `Unknown action "${body.action}"` }, 400);
    }
  });
}

/** GET: validate + derived counters for dashboards. */
export async function GET(_req: Request, { params }: { params: Promise<{ examId: string }> }) {
  return route(async () => {
    await requireFaculty();
    const { examId } = await params;
    const validation = await validateExamForApproval(examId);
    const counts = await prisma.writingQuestionGrade.groupBy({ by: ["submissionId"], _count: true }).catch(() => []);
    void counts;
    return jsonOk(validation);
  });
}
