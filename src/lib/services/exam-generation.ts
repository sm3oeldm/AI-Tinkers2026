// AI exam drafting (spec PART 2). Gemma receives ONLY the professor-selected
// sections; output is strictly validated before anything is persisted, and the
// result is always a DRAFT exam for faculty review — never auto-published.

import { prisma } from "../db";
import { ApiError } from "../http";
import { getProvider, providerDescription, extractJson, LlmProvider } from "../llm";
import {
  GenerationParams,
  PROMPT_VERSIONS,
  buildMcqGenerationPrompt,
  buildRegenerateQuestionPrompt,
  buildRubricPrompt,
  buildWritingGenerationPrompt,
} from "../prompts";
import { assertChaptersOwned, loadSelectedSections, PromptSection } from "../sections";
import { questionDuplicateScore, truncate } from "../text";
import {
  ExamConfig,
  LlmMcq,
  LlmRubric,
  LlmWriting,
  configTotalMarks,
  llmExamBatchSchema,
  llmMcqSchema,
  llmRegeneratedQuestionSchema,
  llmRubricSchema,
  llmWritingSchema,
} from "../validation";

const DUPLICATE_THRESHOLD = 0.72;
const MAX_BUDGET_ROUNDS = 3;

export interface DraftGenerationResult {
  examId: string;
  warnings: string[];
}

export async function generateDraftExam(
  courseId: string,
  facultyId: string,
  cfg: ExamConfig,
  selection: { selectedChapterIds: string[]; includeSyllabus: boolean; additionalMaterialDocumentIds: string[] }
): Promise<DraftGenerationResult> {
  await assertChaptersOwned(courseId, selection.selectedChapterIds);
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { id: true, code: true, title: true } });
  if (!course) throw new ApiError(404, "Course not found");

  const selectionResult = await loadSelectedSections(courseId, selection);
  const warnings: string[] = [];
  for (const u of selectionResult.unavailable) warnings.push(`Document "${u.title}" could not be used: ${u.reason}`);
  if (selectionResult.sections.length === 0) {
    throw new ApiError(422, "No usable source material for the selected chapters. Fix the failing documents before generating the exam.", {
      unavailable: selectionResult.unavailable,
    });
  }
  if (selectionResult.truncated) {
    warnings.push("Source material exceeded the generation context budget; some content was omitted. Consider selecting fewer chapters.");
  }

  const provider = getProvider();
  const providerInfo = providerDescription();
  const courseLabel = `${course.code} — ${course.title}`;
  const params: GenerationParams = {
    courseLabel,
    examTitle: cfg.title,
    instructions: cfg.instructions ?? null,
    sections: selectionResult.sections,
  };
  const sourceDocIds = [...new Set(selectionResult.sections.map((s) => s.documentId))];

  // ---- MCQ batch ---------------------------------------------------------
  const { results: mcqs, warnings: mcqWarnings } = await runMcqBatch(provider, params, cfg, []);
  warnings.push(...mcqWarnings);

  // ---- Writing batch -----------------------------------------------------
  const { results: writings, warnings: writingWarnings } = await runWritingBatch(provider, params, cfg, mcqs.map((m) => m.question));
  warnings.push(...writingWarnings);

  // ---- Rubric drafts (mandatory for every writing question) --------------
  const rubricDrafts: Array<{ criteria: LlmRubric["criteria"]; matchOk: boolean }> = [];
  for (const w of writings) {
    const draft = await generateRubricDraft(provider, courseLabel, w, cfg.writing.marksPerQuestion, warnings);
    rubricDrafts.push(draft);
  }

  // ---- Persist exam + questions + rubric drafts in ONE transaction -------
  const totalMarks = configTotalMarks(cfg);
  void totalMarks;
  const promptVersions: Record<string, string> = {};
  if (cfg.mcq.count > 0) promptVersions.mcq = PROMPT_VERSIONS.mcqGeneration;
  if (cfg.writing.count > 0) promptVersions.writing = PROMPT_VERSIONS.writingGeneration;
  if (cfg.writing.count > 0) promptVersions.rubric = PROMPT_VERSIONS.rubricGeneration;

  const exam = await prisma.$transaction(async (tx) => {
    const created = await tx.exam.create({
      data: {
        courseId,
        title: cfg.title,
        description: cfg.description ?? null,
        instructions: cfg.instructions ?? null,
        durationMinutes: cfg.durationMinutes,
        difficulty: cfg.difficulty,
        isAiGenerated: true,
        status: "DRAFT",
        generationMeta: JSON.stringify({
          provider: providerInfo.provider,
          model: providerInfo.model,
          configuredModel: providerInfo.keyConfigured ? providerInfo.model : providerInfo.model,
          keyConfigured: providerInfo.keyConfigured,
          promptVersions,
          sourceDocIds,
          sectionLabels: [...new Set(selectionResult.sections.map((s) => s.label))],
          selection,
          warnings,
          declaredTotalMarks: cfg.declaredTotalMarks ?? totalMarks,
          generatedAt: new Date().toISOString(),
        }),
        generatedById: facultyId,
      },
    });

    let order = 1;
    for (const m of mcqs) {
      await tx.examQuestion.create({
        data: {
          examId: created.id,
          order: order++,
          type: "MCQ",
          text: m.question,
          marks: cfg.mcq.marksPerQuestion,
          optionsJson: JSON.stringify(m.options),
          correctAnswerId: m.correct_answer_id,
          explanation: m.explanation ?? null,
          sourceRefsJson: JSON.stringify(sourceRef(m.source_reference, sourceDocIds)),
          difficulty: m.difficulty ?? null,
        },
      });
    }
    for (let i = 0; i < writings.length; i++) {
      const w = writings[i];
      const q = await tx.examQuestion.create({
        data: {
          examId: created.id,
          order: order++,
          type: "WRITING",
          text: w.question,
          marks: cfg.writing.marksPerQuestion,
          expectedAnswer: w.expected_answer,
          sourceRefsJson: JSON.stringify(sourceRef(w.source_reference, sourceDocIds)),
          difficulty: w.difficulty ?? null,
          needsRubricFix: !rubricDrafts[i]?.matchOk,
        },
      });
      await tx.rubric.create({
        data: {
          questionId: q.id,
          version: 1,
          status: "DRAFT",
          criteria: {
            create: rubricDrafts[i].criteria.map((c, ci) => ({
              order: ci + 1,
              name: c.name,
              description: c.description,
              maxMarks: c.max_marks,
              fullCredit: c.full_credit_requirements,
              partialCredit: c.partial_credit_requirements,
              commonMistakes: c.common_mistakes ?? null,
              acceptableAlternatives: c.acceptable_alternatives ?? null,
            })),
          },
        },
      });
    }
    return created;
  });

  return { examId: exam.id, warnings };
}

function sourceRef(ref: string | undefined | null, docIds: string[]) {
  return [{ kind: "document", label: ref ?? `(doc ${docIds[0] ?? "?"})`, documentId: docIds[0] ?? "" }];
}

function validateMcq(m: LlmMcq, warnings: string[]): boolean {
  if (!m.options.some((o) => o.id === m.correct_answer_id)) {
    warnings.push(`MCQ "${truncate(m.question, 60)}" was dropped: its correct answer id "${m.correct_answer_id}" is not one of the provided options.`);
    return false;
  }
  const ids = new Set(m.options.map((o) => o.id));
  if (ids.size !== m.options.length) {
    warnings.push(`MCQ "${truncate(m.question, 60)}" was dropped: duplicate option ids.`);
    return false;
  }
  return true;
}

async function generateMcqBatchCall(
  provider: LlmProvider,
  params: GenerationParams,
  wants: { count: number; marksPerQuestion: number; difficulty: string },
  avoid: string[]
): Promise<LlmMcq[]> {
  const prompt = buildMcqGenerationPrompt(params, { ...wants, avoidQuestionTexts: avoid });
  const res = await provider.generate(prompt, { temperature: 0.4 });
  const batch = llmExamBatchSchema.parse(extractJson(res.text));
  return batch.mcqs.map((m) => llmMcqSchema.parse(m));
}

async function runMcqBatch(
  provider: LlmProvider,
  params: GenerationParams,
  cfg: ExamConfig,
  avoid: string[]
): Promise<{ results: LlmMcq[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (cfg.mcq.count === 0) return { results: [], warnings };

  const accepted: LlmMcq[] = [];
  for (let round = 0; round < MAX_BUDGET_ROUNDS && accepted.length < cfg.mcq.count; round++) {
    const wants = { count: cfg.mcq.count - accepted.length, marksPerQuestion: cfg.mcq.marksPerQuestion, difficulty: cfg.difficulty };
    try {
      const batch = await generateMcqBatchCall(provider, params, wants, [...accepted.map((a) => a.question), ...avoid]);
      for (const m of batch) {
        if (accepted.length >= cfg.mcq.count) break;
        if (!validateMcq(m, warnings)) continue;
        if (accepted.some((a) => questionDuplicateScore(a.question, m.question) >= DUPLICATE_THRESHOLD)) {
          warnings.push(`Duplicate MCQ "${truncate(m.question, 60)}" skipped.`);
          continue;
        }
        accepted.push(m);
      }
    } catch (err) {
      warnings.push(`MCQ generation round ${round + 1} produced invalid output (${err instanceof Error ? err.message : String(err)}).`);
    }
  }
  if (accepted.length < cfg.mcq.count) {
    warnings.push(
      `Only ${accepted.length} of ${cfg.mcq.count} requested MCQs passed validation; add questions manually or regenerate.`
    );
  }
  return { results: accepted, warnings };
}

async function generateWritingBatchCall(
  provider: LlmProvider,
  params: GenerationParams,
  wants: { count: number; marksPerQuestion: number; difficulty: string }
): Promise<LlmWriting[]> {
  const prompt = buildWritingGenerationPrompt(params, wants);
  const res = await provider.generate(prompt, { temperature: 0.4 });
  const batch = llmExamBatchSchema.parse(extractJson(res.text));
  return batch.writing_questions.map((w) => llmWritingSchema.parse(w));
}

async function runWritingBatch(
  provider: LlmProvider,
  params: GenerationParams,
  cfg: ExamConfig,
  avoid: string[]
): Promise<{ results: LlmWriting[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (cfg.writing.count === 0) return { results: [], warnings };

  const accepted: LlmWriting[] = [];
  for (let round = 0; round < MAX_BUDGET_ROUNDS && accepted.length < cfg.writing.count; round++) {
    const wants = { count: cfg.writing.count - accepted.length, marksPerQuestion: cfg.writing.marksPerQuestion, difficulty: cfg.difficulty };
    try {
      const batch = await generateWritingBatchCall(provider, params, wants);
      for (const w of batch) {
        if (accepted.length >= cfg.writing.count) break;
        const dup = accepted.some((a) => questionDuplicateScore(a.question, w.question) >= DUPLICATE_THRESHOLD);
        if (dup) {
          warnings.push(`Duplicate writing question "${truncate(w.question, 60)}" skipped.`);
          continue;
        }
        accepted.push(w);
      }
    } catch (err) {
      warnings.push(`Writing generation round ${round + 1} produced invalid output (${err instanceof Error ? err.message : String(err)}).`);
    }
  }
  void avoid;
  if (accepted.length < cfg.writing.count) {
    warnings.push(
      `Only ${accepted.length} of ${cfg.writing.count} requested writing questions passed validation; add questions manually or regenerate.`
    );
  }
  return { results: accepted, warnings };
}

// ---- Rubric drafts ---------------------------------------------------------

async function generateRubricDraft(
  provider: LlmProvider,
  courseLabel: string,
  writing: LlmWriting,
  marks: number,
  warnings: string[]
): Promise<{ criteria: LlmRubric["criteria"]; matchOk: boolean }> {
  const attempt = async (correction: string | null): Promise<LlmRubric | null> => {
    const prompt = buildRubricPrompt({
      questionText: writing.question,
      marks,
      expectedAnswer: writing.expected_answer,
      courseLabel,
    });
    if (correction) prompt.userPrompt += `\nIMPORTANT correction: ${correction}`;
    try {
      const res = await provider.generate(prompt, { temperature: 0.2 });
      return llmRubricSchema.parse(extractJson(res.text));
    } catch {
      return null;
    }
  };

  const sumOf = (r: LlmRubric | null) => (r ? r.criteria.reduce((a, c) => a + c.max_marks, 0) : NaN);

  let rubric = await attempt(null);
  if (rubric && Math.abs(sumOf(rubric) - marks) > 1e-9) {
    rubric = await attempt(`criteria currently sum to ${sumOf(rubric)} but must sum to exactly ${marks}. Adjust each criterion's max_marks.`);
    if (rubric && Math.abs(sumOf(rubric) - marks) > 1e-9) {
      warnings.push(
        `Draft rubric for "${truncate(writing.question, 60)}" sums to ${sumOf(rubric)} instead of ${marks} — it is editable and flagged NEEDS_FIX for faculty approval.`
      );
      return { criteria: rubric.criteria, matchOk: false };
    }
  }
  if (!rubric) {
    warnings.push(`Rubric generation failed for "${truncate(writing.question, 60)}" — an editable placeholder draft was inserted and flagged NEEDS_FIX.`);
    const n = Math.min(5, Math.max(1, Math.ceil(marks / 2)));
    const per = Math.floor(marks / n);
    const list = (() => {
      const arr = Array.from({ length: n }, () => per);
      arr[0] = Math.round((marks - per * (n - 1)) * 2) / 2;
      return arr;
    })();
    rubric = {
      criteria: list.map((m, i) => ({
        name: `Criterion ${i + 1}`,
        description: `DRAFT (please edit): assessing key aspect ${i + 1}.`,
        max_marks: m || marks,
        full_credit_requirements: "DRAFT (please edit): answer addresses this aspect completely.",
        partial_credit_requirements: "DRAFT (please edit): answer partially addresses this aspect.",
        common_mistakes: null,
        acceptable_alternatives: null,
      })),
    };
    return { criteria: rubric.criteria, matchOk: false };
  }
  return { criteria: rubric.criteria, matchOk: true };
}

// ---- Single-question regeneration (drafts only) -----------------------------

export async function regenerateDraftQuestion(
  examId: string,
  questionId: string,
  facultyId: string
): Promise<{ warnings: string[] }> {
  void facultyId;
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) throw new ApiError(404, "Exam not found");
  if (exam.status !== "DRAFT") throw new ApiError(409, "Questions can only be regenerated while the exam is a DRAFT");

  const question = await prisma.examQuestion.findFirst({ where: { id: questionId, examId } });
  if (!question) throw new ApiError(404, "Question not found");

  const meta = exam.generationMeta ? (JSON.parse(exam.generationMeta) as { selection?: { selectedChapterIds: string[]; includeSyllabus: boolean; additionalMaterialDocumentIds: string[] } }) : null;
  const selection = meta?.selection ?? { selectedChapterIds: [], includeSyllabus: true, additionalMaterialDocumentIds: [] };
  const course = await prisma.course.findUnique({ where: { id: exam.courseId }, select: { code: true, title: true } });

  const { sections, unavailable } = await loadSelectedSections(exam.courseId, selection);
  if (sections.length === 0) {
    throw new ApiError(422, "No usable source material available for regeneration.", { unavailable });
  }

  const provider = getProvider();
  const siblings = await prisma.examQuestion.findMany({
    where: { examId, id: { not: questionId } },
    select: { text: true },
  });
  const prompt = buildRegenerateQuestionPrompt({
    courseLabel: `${course?.code} — ${course?.title}`,
    type: question.type as "MCQ" | "WRITING",
    marks: question.marks,
    difficulty: question.difficulty,
    existingQuestions: siblings.map((s) => s.text),
    sections,
  });

  let parsed: ReturnType<typeof llmRegeneratedQuestionSchema.parse> | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    try {
      const res = await provider.generate(prompt, { temperature: 0.35 });
      const candidate = llmRegeneratedQuestionSchema.parse(extractJson(res.text));
      if (candidate.type === "MCQ") {
        if (!candidate.data.options.some((o) => o.id === candidate.data.correct_answer_id)) {
          lastError = "the correct answer id was not among the options";
          continue;
        }
        if (siblings.some((s) => questionDuplicateScore(s.text, candidate.data.question) >= DUPLICATE_THRESHOLD)) {
          lastError = "the regenerated question duplicated an existing question";
          continue;
        }
      } else if (siblings.some((s) => questionDuplicateScore(s.text, candidate.data.question) >= DUPLICATE_THRESHOLD)) {
        lastError = "the regenerated question duplicated an existing question";
        continue;
      }
      parsed = candidate;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  if (!parsed) throw new ApiError(502, `Regeneration failed after 2 attempts: ${lastError || "invalid model output"}`);

  const warnings: string[] = [];
  await prisma.$transaction(async (tx) => {
    if (parsed!.type === "MCQ") {
      await tx.examQuestion.update({
        where: { id: questionId },
        data: {
          text: parsed!.data.question,
          marks: question.marks,
          optionsJson: JSON.stringify(parsed!.data.options),
          correctAnswerId: parsed!.data.correct_answer_id,
          explanation: parsed!.data.explanation,
          difficulty: parsed!.data.difficulty ?? question.difficulty,
        },
      });
    } else {
      const d = parsed!.data;
      await tx.examQuestion.update({
        where: { id: questionId },
        data: {
          text: d.question,
          marks: question.marks,
          expectedAnswer: d.expected_answer,
          difficulty: d.difficulty ?? question.difficulty,
        },
      });
      const latest = await tx.rubric.findFirst({ where: { questionId }, orderBy: { version: "desc" } });
      const courseLabel = `${course?.code} — ${course?.title}`;
      if (latest) {
        const rubric = await generateRubricDraft(provider, courseLabel, d, question.marks, warnings);
        await tx.rubricCriterion.deleteMany({ where: { rubricId: latest.id } });
        await tx.rubricCriterion.createMany({
          data: rubric.criteria.map((c, i) => ({
            rubricId: latest.id,
            order: i + 1,
            name: c.name,
            description: c.description,
            maxMarks: c.max_marks,
            fullCredit: c.full_credit_requirements,
            partialCredit: c.partial_credit_requirements,
            commonMistakes: c.common_mistakes ?? null,
            acceptableAlternatives: c.acceptable_alternatives ?? null,
          })),
        });
        await tx.examQuestion.update({ where: { id: questionId }, data: { needsRubricFix: !rubric.matchOk } });
      }
    }
  });

  return { warnings };
}

// used by prompt-section selection at call sites that need a type-only import
export type { PromptSection };
