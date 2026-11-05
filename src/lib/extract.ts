// Text extraction for supported upload formats: PDF (unpdf — keeps page
// boundaries), DOCX (mammoth), TXT/MD (utf-8). Errors carry clear reasons.

export interface ExtractedText {
  pages: string[];
  pageCount: number | null;
}

export async function extractText(buffer: Buffer, mimeType: string, originalName: string): Promise<ExtractedText> {
  if (mimeType === "application/pdf" || /\.pdf$/i.test(originalName)) {
    try {
      const { getDocumentProxy, extractText } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text, totalPages } = await extractText(pdf, { mergePages: false });
      const pages = Array.isArray(text) ? text : [text];
      if (!pages.some((p) => p && p.trim().length > 0)) {
        throw new Error("No selectable text found in the PDF — it may contain only scanned images. Please provide a text version.");
      }
      return { pages, pageCount: totalPages ?? null };
    } catch (err) {
      if (err instanceof Error && err.message.includes("scanned images")) throw err;
      throw new Error(`PDF parse failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    /\.docx$/i.test(originalName)
  ) {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      const text = result.value;
      if (!text.trim()) throw new Error("The DOCX file contained no extractable text.");
      return { pages: [text], pageCount: null };
    } catch (err) {
      if (err instanceof Error && err.message.includes("no extractable")) throw err;
      throw new Error(`DOCX parse failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (mimeType === "text/plain" || mimeType === "text/markdown" || /\.(txt|md)$/i.test(originalName)) {
    const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
    if (!text.trim()) throw new Error("The text file is empty.");
    return { pages: [text], pageCount: null };
  }

  throw new Error(
    `Unsupported file type "${mimeType || "unknown"}" for "${originalName}". Supported: PDF, DOCX, TXT, MD.`
  );
}
