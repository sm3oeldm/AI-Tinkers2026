// Course-document processing: store the original file, extract text with
// structure (headings + page locators), and record clear failure reasons —
// per spec: "If a document cannot be processed, clearly inform the professor."
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "./db";
import { config } from "./config";
import { extractText } from "./extract";

export const SUPPORTED_MIME = new Map<string, string>([
  ["application/pdf", ".pdf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["text/plain", ".txt"],
  ["text/markdown", ".md"],
]);

export interface UploadParams {
  courseId: string;
  chapterId?: string | null;
  kind: "SYLLABUS" | "CHAPTER" | "MATERIAL";
  originalName: string;
  mimeType: string;
  buffer: Buffer;
  visibleToStudents?: boolean;
}

export async function processAndStoreDocument(id: string, p: UploadParams): Promise<void> {
  // Extraction happens outside a tx (slow); status transitions bracket it.
  try {
    await fs.mkdir(config.uploadDir, { recursive: true });
    const filename = `${id}${SUPPORTED_MIME.get(p.mimeType) ?? typeFromName(p.originalName)}`;
    await fs.writeFile(path.join(config.uploadDir, filename), p.buffer);

    const extracted = await extractText(p.buffer, p.mimeType, p.originalName);
    const segments = buildSegments(extracted.pages, extracted.pageCount);

    await prisma.$transaction(async (tx) => {
      await tx.document.update({
        where: { id },
        data: {
          status: "PROCESSED",
          pageCount: extracted.pageCount,
          wordCount: extracted.pages.join(" ").split(/\s+/).filter(Boolean).length,
          processedAt: new Date(),
          filename,
        },
      });
      await tx.documentSegment.createMany({
        data: segments.map((s, i) => ({
          documentId: id,
          index: i,
          heading: s.heading,
          page: s.page,
          text: s.text,
        })),
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.document
      .update({ where: { id, status: "PROCESSING" }, data: { status: "FAILED", extractionError: `Extraction failed: ${message}` } })
      .catch(() => undefined);
    throw err;
  }
}

function typeFromName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return [".pdf", ".docx", ".txt", ".md"].includes(ext) ? ext : "";
}

/** Upload mime/extension allow-list check, called before a row is created. */
export function validateUploadBuffer(mimeType: string, originalName: string): { ok: boolean; message?: string } {
  if (!SUPPORTED_MIME.has(mimeType) && !typeFromName(originalName)) {
    return {
      ok: false,
      message: `Unsupported file type. Supported: PDF, DOCX, TXT, MD (received mime "${mimeType || "unknown"}").`,
    };
  }
  return { ok: true };
}

/** Turn extracted page texts into retrieval-friendly segments: one segment per
 * page for PDFs (page locators kept), long pages split in half for prompt
 * budgeting; non-PDF text split by size at paragraph boundaries. */
function buildSegments(pages: string[], pageCount: number | null): Array<{ heading: string | null; page: number | null; text: string }> {
  const segments: Array<{ heading: string | null; page: number | null; text: string }> = [];
  const MAX = 2600;

  const pushSeg = (text: string, page: number | null) => {
    const t = text.replace(/\u0000/g, "").trim();
    if (t.length === 0) return;
    const [first, ...rest] = t.split(/\n+/);
    const heading = !rest.length ? null : first.length <= 90 && /[A-Za-z]/.test(first) ? first.trim() : null;
    segments.push({ heading, page, text: t });
  };

  if (pageCount != null) {
    pages.forEach((pageText, i) => {
      const clean = pageText.trim();
      if (!clean) return;
      if (clean.length <= MAX) pushSeg(clean, i + 1);
      else {
        for (let idx = 0; idx < clean.length; idx += MAX) {
          pushSeg(clean.slice(idx, idx + MAX), i + 1);
        }
      }
    });
  } else {
    const paragraphs = pages.join("\n\n").split(/\n{2,}/);
    let current = "";
    for (const para of paragraphs) {
      current = current ? `${current}\n\n${para}` : para;
      if (current.length >= 1600) {
        if (current.length > MAX) current = sliceByWords(current, MAX);
        pushSeg(current, null);
        current = "";
      }
    }
    if (current.trim()) pushSeg(current, null);
  }

  return segments;
}

function sliceByWords(t: string, max: number): string {
  if (t.length <= max) return t;
  return t.slice(0, max);
}
