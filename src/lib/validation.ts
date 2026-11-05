// Shared typed schemas. Generated/graded model outputs are ALWAYS validated
// here before anything is trusted (spec: "Use structured outputs where
// supported and server-side validation regardless").
import { z } from "zod";

// ---------------------------------------------------------------------------
// Exam configuration (faculty wizard → POST /api/courses/:id/exams/generate)
// ---------------------------------------------------------------------------
export const examConfigSchema = z
  .object({
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(2000).optional().nullable(),
    instructions: z.string().trim().max(5000).optional().nullable(),
    durationMinutes: z.coerce.number().int().min(1).max(600),
    difficulty: z.enum(["mixed", "easy", "medium", "hard"]).default("mixed"),
    // Selected chapters define the ONLY permitted source material.
    selectedChapterIds: z.array(z.string()).default([]),
    includeSyllabus: z.boolean().default(true),
    additionalMaterialDocumentIds: z.array(z.string()).default([]),
    mcq: z.object({
      count: z.coerce.number().int().min(0).max(60),
      marksPerQuestion: z.coerce.number().min(0.5).max(100),
    }),
    writing: z.object({
      count: z.coerce.number().int().min(0).max(20),
      marksPerQuestion: z.coerce.number().min(0.5).max(100),
    }),
    // Faculty may also set the target total; it must equal the computed sum
    // exactly when provided (validated below).
    declaredTotalMarks: z.coerce.number().min(0.5).optional().nullable(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.selectedChapterIds.length === 0 && !cfg.includeSyllabus && cfg.additionalMaterialDocumentIds.length === 0) {
      ctx.addIssue({ code: "custom", message: "Select at least one chapter, the syllabus, or extra materials as the question source." });
    }
    if (cfg.mcq.count + cfg.writing.count === 0) {
      ctx.addIssue({ code: "custom", message: "Configure at least one question (MCQ or writing)." });
    }
    const computed = cfg.mcq.count * cfg.mcq.marksPerQuestion + cfg.writing.count * cfg.writing.marksPerQuestion;
    if (cfg.declaredTotalMarks != null && Math.abs(cfg.declaredTotalMarks - computed) > 1e-9) {
      ctx.addIssue({
        code: "custom",
        message: `Total marks (${cfg.declaredTotalMarks}) do not match the configured questions (${computed}).`,
      });
    }
  });

export type ExamConfig = z.infer<typeof examConfigSchema>;

export function configTotalMarks(cfg: ExamConfig): number {
  return cfg.mcq.count * cfg.mcq.marksPerQuestion + cfg.writing.count * cfg.writing.marksPerQuestion;
}

// ---------------------------------------------------------------------------
// Draft/editing payloads
// ---------------------------------------------------------------------------
export const optionSchema = z.object({ id: z.string().min(1).max(8), text: z.string().trim().min(1).max(2000) });
export type Option = z.infer<typeof optionSchema>;

export const mcqQuestionPatchSchema = z.object({
  text: z.string().trim().min(1).max(4000).optional(),
  marks: z.coerce.number().min(0.5).max(200).optional(),
  options: z.array(optionSchema).min(2).max(6).optional(),
  correctAnswerId: z.string().min(1).optional(),
  explanation: z.string().trim().max(4000).optional().nullable(),
  sourceRefsJson: z.string().optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional().nullable(),
});
export type McqQuestionPatch = z.infer<typeof mcqQuestionPatchSchema>;

export const writingQuestionPatchSchema = z.object({
  text: z.string().trim().min(1).max(4000).optional(),
  marks: z.coerce.number().min(0.5).max(200).optional(),
  expectedAnswer: z.string().trim().max(8000).optional(),
  sourceRefsJson: z.string().optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional().nullable(),
});

const criterionPatch = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  maxMarks: z.coerce.number().min(0.5).max(200),
  fullCredit: z.string().trim().min(1).max(2000),
  partialCredit: z.string().trim().min(1).max(2000),
  commonMistakes: z.string().trim().max(2000).optional().nullable(),
  acceptableAlternatives: z.string().trim().max(2000).optional().nullable(),
});

export const rubricPatchSchema = z.object({ criteria: z.array(criterionPatch).min(1).max(12) });
export type RubricPatch = z.infer<typeof rubricPatchSchema>;

// ---------------------------------------------------------------------------
// Model output schemas — generation
// ---------------------------------------------------------------------------

export const llmMcqSchema = z.object({
  question: z.string().trim().min(1).max(3000),
  options: z.array(optionSchema).min(4).max(6),
  correct_answer_id: z.string().trim().min(1).max(8),
  explanation: z.string().trim().min(1).max(3000),
  source_reference: z.string().trim().max(500).optional().nullable(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional().nullable(),
});
export type LlmMcq = z.infer<typeof llmMcqSchema>;

export const llmWritingSchema = z.object({
  question: z.string().trim().min(1).max(3000),
  expected_answer: z.string().trim().min(1).max(8000),
  source_reference: z.string().trim().max(500).optional().nullable(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional().nullable(),
});
export type LlmWriting = z.infer<typeof llmWritingSchema>;

export const llmExamBatchSchema = z.object({
  mcqs: z.array(llmMcqSchema).default([]),
  writing_questions: z.array(llmWritingSchema).default([]),
});
export type LlmExamBatch = z.infer<typeof llmExamBatchSchema>;

export const llmRubricSchema = z.object({
  criteria: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().min(1).max(2000),
        max_marks: z.coerce.number().min(0.5).max(200),
        full_credit_requirements: z.string().trim().min(1).max(2000),
        partial_credit_requirements: z.string().trim().min(1).max(2000),
        common_mistakes: z.string().trim().max(2000).optional().nullable(),
        acceptable_alternatives: z.string().trim().max(2000).optional().nullable(),
      })
    )
    .min(1)
    .max(12),
});
export type LlmRubric = z.infer<typeof llmRubricSchema>;

export const llmRegeneratedQuestionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("MCQ"), data: llmMcqSchema }),
  z.object({ type: z.literal("WRITING"), data: llmWritingSchema }),
]);
export type LlmRegeneratedQuestion = z.infer<typeof llmRegeneratedQuestionSchema>;

// ---------------------------------------------------------------------------
// Model output schemas — grading
// ---------------------------------------------------------------------------

export const llmEvidenceItemSchema = z.object({
  quote: z.string().trim().min(1).max(1500),
  explanation: z.string().trim().min(1).max(1500),
});
export type LlmEvidenceItem = z.infer<typeof llmEvidenceItemSchema>;

export const llmCriterionResultSchema = z.object({
  criterion_id: z.string().trim().min(1).max(64),
  criterion_name: z.string().trim().min(1).max(200),
  maximum_marks: z.coerce.number().min(0).max(200),
  awarded_marks: z.coerce.number().min(0).max(200),
  evidence: z.array(llmEvidenceItemSchema).max(10),
  feedback: z.string().trim().min(1).max(3000),
});
export type LlmCriterionResult = z.infer<typeof llmCriterionResultSchema>;

export const llmGradeOutputSchema = z.object({
  criteria_results: z.array(llmCriterionResultSchema).min(1).max(20),
  overall_feedback: z.string().trim().min(1).max(3000),
  requires_human_review: z.boolean().optional().default(false),
  review_reasons: z.array(z.string().trim().max(400)).max(10).optional().default([]),
  confidence: z.coerce.number().min(0).max(1).optional().nullable(),
});
export type LlmGradeOutput = z.infer<typeof llmGradeOutputSchema>;

// ---------------------------------------------------------------------------
// Submission payloads
// ---------------------------------------------------------------------------
export const submitAnswersSchema = z.object({
  answers: z
    .array(
      z.object({
        questionId: z.string().min(1),
        selectedOptionId: z.string().min(1).max(8).optional().nullable(),
        text: z.string().max(20000).optional().nullable(),
      })
    )
    .max(200),
});

export const reviewActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("override"),
    questionId: z.string().min(1),
    criterionMarks: z
      .array(z.object({ criterionId: z.string(), awardedMarks: z.coerce.number().min(0).max(200) }))
      .min(1),
    feedback: z.string().trim().max(4000).optional().nullable(),
    reason: z.string().trim().min(3).max(1000),
  }),
  z.object({
    action: z.literal("approve_question"),
    questionId: z.string().min(1),
    reason: z.string().trim().max(1000).optional().nullable(),
  }),
  z.object({
    action: z.literal("approve_all"),
    reason: z.string().trim().max(1000).optional().nullable(),
  }),
  z.object({
    action: z.literal("release"),
    reason: z.string().trim().max(1000).optional().nullable(),
  }),
  z.object({
    action: z.literal("regrade"),
    questionId: z.string().min(1),
    reason: z.string().trim().max(1000).optional().nullable(),
  }),
]);
