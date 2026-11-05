import { NextRequest } from "next/server";
import { checkOrigin, jsonOk, readJson, route } from "@/lib/http";
import { requireStudent } from "@/lib/access";
import { prisma } from "@/lib/db";
import { tokenize, truncate } from "@/lib/text";

/** Private Q&A: deterministic retrieval over THIS course's extracted documents.
 * Answers cite source chips (doc + page). Untrusted document text is data only. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ courseId: string }> }) {
  return route(async () => {
    checkOrigin(req);
    const user = await requireStudent();
    const { courseId } = await params;
    const enrollment = await prisma.enrollment.findUnique({ where: { courseId_userId: { courseId, userId: user.id } } });
    if (!enrollment) return jsonOk({ error: "Not enrolled" }, 403);

    const body = await readJson<{ question?: string }>(req);
    const question = (body.question ?? "").trim();
    if (question.length < 3) return jsonOk({ error: "Type a question first" }, 400);

    const segments = await prisma.documentSegment.findMany({
      where: { document: { courseId, status: "PROCESSED" } },
      include: { document: { include: { chapter: true } } },
      take: 400,
    });

    const qTokens = tokenize(question);
    const scored = segments
      .map((seg) => {
        const sTokens = new Set(tokenize(seg.text));
        let hits = 0;
        for (const t of qTokens) if (sTokens.has(t)) hits++;
        return { seg, score: hits / Math.max(1, qTokens.length) };
      })
      .filter((x) => x.score >= 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const enough = scored.length > 0 && scored[0].score >= 0.34;
    const sources = scored.map((s) => ({
      documentId: s.seg.documentId,
      label: s.seg.document.kind === "SYLLABUS" ? "Syllabus" : s.seg.document.title,
      page: s.seg.page,
      excerpt: truncate(s.seg.text, 220),
    }));

    const answer = enough
      ? `Based on the course material (see sources), here is what I found for "${truncate(question, 120)}":\n\n${sources
          .map((s, i) => `${i + 1}. ${s.excerpt}`)
          .join("\n")}`
      : "Your lecture notes and course materials don't clearly cover that. Please check with your instructor after class.";

    const entry = await prisma.qaEntry.create({
      data: {
        courseId,
        studentId: user.id,
        question,
        answer,
        status: enough ? "SUPPORTED" : "INSUFFICIENT_EVIDENCE",
        sourcesJson: JSON.stringify(sources),
      },
    });
    return jsonOk({ entry: { ...entry, sources: JSON.parse(entry.sourcesJson) } }, 201);
  });
}

/** GET: own Q&A history. */
export async function GET(_req: Request, { params }: { params: Promise<{ courseId: string }> }) {
  return route(async () => {
    const user = await requireStudent();
    const { courseId } = await params;
    const entries = await prisma.qaEntry.findMany({
      where: { courseId, studentId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return jsonOk({ entries: entries.map((e) => ({ ...e, sources: JSON.parse(e.sourcesJson) })) });
  });
}
