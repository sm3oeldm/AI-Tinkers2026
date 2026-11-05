import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { checkOrigin, jsonOk, route } from "@/lib/http";
import { requireCourseOwner, requireFaculty } from "@/lib/access";
import { processAndStoreDocument, validateUploadBuffer } from "@/lib/documents";

/** POST multipart/form-data: file, kind, chapterId?, title?, visible */
export async function POST(req: NextRequest, { params }: { params: Promise<{ courseId: string }> }) {
  return route(async () => {
    checkOrigin(req);
    const user = await requireFaculty();
    const { courseId } = await params;
    await requireCourseOwner(courseId, user);

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return jsonOk({ error: "file field required" }, 400);
    const kindRaw = String(form.get("kind") ?? "CHAPTER");
    const kind = (["SYLLABUS", "CHAPTER", "MATERIAL"].includes(kindRaw) ? kindRaw : "CHAPTER") as "SYLLABUS" | "CHAPTER" | "MATERIAL";
    const chapterIdRaw = String(form.get("chapterId") ?? "").trim();
    const visible = String(form.get("visible") ?? "true") !== "false";

    const buffer = Buffer.from(await file.arrayBuffer());
    const v = validateUploadBuffer(file.type, file.name);
    if (!v.ok) return jsonOk({ error: v.message }, 400);

    const doc = await prisma.document.create({
      data: {
        courseId,
        chapterId: kind === "SYLLABUS" ? null : chapterIdRaw || null,
        kind,
        title: String(form.get("title") ?? file.name).slice(0, 180) || file.name,
        originalName: file.name,
        filename: "",
        mimeType: file.type,
        sizeBytes: buffer.length,
        status: "PROCESSING",
        visibleToStudents: visible,
      },
    });

    // Kick off extraction; failures are reported on the document row.
    processAndStoreDocument(doc.id, {
      courseId,
      chapterId: doc.chapterId,
      kind,
      originalName: file.name,
      mimeType: file.type,
      buffer,
      visibleToStudents: visible,
    }).catch((err) => console.error("[documents] extraction failed:", err));

    return jsonOk({ document: { id: doc.id, title: doc.title, status: "PROCESSING" } }, 201);
  });
}
