// Loads the actual extracted document text for the professor's selection.
// Unselected chapters never reach the model — enforced here (only the
// selected docs enter the prompt at all).
import { prisma } from "./db";
import { ApiError } from "./http";

export interface PromptSection {
  label: string;
  documentId: string;
  heading?: string | null;
  page?: number | null;
  text: string;
}

export interface SelectionInfo {
  selectedChapterIds: string[];
  includeSyllabus: boolean;
  additionalMaterialDocumentIds: string[];
}

export interface SelectionResult {
  sections: PromptSection[];
  /** Documents the professor expects but that cannot be used. */
  unavailable: Array<{ documentId: string; title: string; reason: string }>;
  truncated: boolean;
}

const MAX_PROMPT_CHARS = 48000;

export async function loadSelectedSections(courseId: string, selection: SelectionInfo): Promise<SelectionResult> {
  const documents = await prisma.document.findMany({
    where: {
      courseId,
      OR: [
        ...(selection.selectedChapterIds.length ? [{ chapterId: { in: selection.selectedChapterIds } }] : []),
        ...(selection.includeSyllabus ? [{ kind: "SYLLABUS" as const }] : []),
        ...(selection.additionalMaterialDocumentIds.length
          ? [{ id: { in: selection.additionalMaterialDocumentIds } }]
          : []),
      ],
    },
    include: {
      chapter: true,
      segments: { orderBy: { index: "asc" } },
    },
    orderBy: [{ chapter: { order: "asc" } }, { createdAt: "asc" }],
  });

  const sections: PromptSection[] = [];
  const unavailable: Array<{ documentId: string; title: string; reason: string }> = [];
  let totalChars = 0;
  let truncated = false;

  for (const doc of documents) {
    if (doc.status === "FAILED") {
      unavailable.push({ documentId: doc.id, title: doc.title, reason: doc.extractionError || "Text extraction failed" });
      continue;
    }
    if (doc.status !== "PROCESSED" || doc.segments.length === 0) {
      unavailable.push({ documentId: doc.id, title: doc.title, reason: doc.status === "PROCESSING" ? "Still processing" : "No extracted text available" });
      continue;
    }
    const label =
      doc.kind === "SYLLABUS"
        ? "SYLLABUS"
        : doc.kind === "CHAPTER" && doc.chapter
          ? `Chapter ${doc.chapter.shortId}: ${doc.chapter.title}`
          : `Material: ${doc.title}`;

    for (const seg of doc.segments) {
      if (totalChars + seg.text.length > MAX_PROMPT_CHARS) {
        truncated = true;
        break;
      }
      sections.push({
        label,
        documentId: doc.id,
        heading: seg.heading,
        page: seg.page,
        text: seg.text,
      });
      totalChars += seg.text.length;
    }
  }

  return { sections, unavailable, truncated };
}

export async function assertChaptersOwned(courseId: string, chapterIds: string[]): Promise<void> {
  if (chapterIds.length === 0) return;
  const chapters = await prisma.chapter.findMany({ where: { id: { in: chapterIds } }, select: { id: true, courseId: true } });
  const bad = chapterIds.filter((id) => !chapters.some((c) => c.id === id));
  if (bad.length) throw new ApiError(400, "Unknown chapter selected", { unknownChapterIds: bad });
  const foreign = chapters.filter((c) => c.id !== undefined && c.courseId !== courseId);
  if (foreign.length) throw new ApiError(403, "Selected chapters do not belong to this course");
}
