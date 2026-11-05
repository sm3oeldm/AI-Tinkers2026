import { NextRequest } from "next/server";
import { checkOrigin, jsonOk, readJson, route } from "@/lib/http";
import { requireCourseOwner, requireFaculty } from "@/lib/access";
import { generateDraftExam } from "@/lib/services/exam-generation";
import { examConfigSchema, ExamConfig } from "@/lib/validation";

export async function POST(req: NextRequest, { params }: { params: Promise<{ courseId: string }> }) {
  return route(async () => {
    checkOrigin(req);
    const user = await requireFaculty();
    const { courseId } = await params;
    await requireCourseOwner(courseId, user);
    const body = await readJson<Record<string, unknown>>(req);
    const parsed = examConfigSchema.safeParse(body);
    if (!parsed.success) {
      return jsonOk({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    }
    const config: ExamConfig = parsed.data;
    const result = await generateDraftExam(courseId, user.id, config, {
      selectedChapterIds: config.selectedChapterIds,
      includeSyllabus: config.includeSyllabus,
      additionalMaterialDocumentIds: config.additionalMaterialDocumentIds,
    });
    return jsonOk(result, 201);
  });
}
