# Integration Plan — AI Exam Generation & Automatic Grading into Course Companion

**Phase 1 deliverable** (per the task spec, PART 1 & PART 9). This document records the mandatory
codebase analysis and the concrete integration plan that the implementation follows.

---

## 1. Codebase analysis (what actually exists)

| System | Existing implementation | Notes |
| --- | --- | --- |
| Frontend | `prototype/student.html` (574 lines), `prototype/faculty.html` (662 lines), `prototype/styles.css` | AAU Moodle visual shell: white utility bar, navy title bar (`#2b353b`), red accents (`#a83332`), collapsible week-sections, activity rows, rubric tables, source chips, status badges, campus footer. |
| Backend | `prototype/server.js` (178 lines) | Static file server **+ real Gemini Live transcription proxy** over WebSocket (`/ws/transcribe`). Nothing else. No auth, no REST API, no DB. |
| Data storage | Browser `localStorage` (`app.js`, key `courseCompanionDB_v3`) | Seed includes course PHYS-I-61D, students, slides, past exams, a practice activity with a 4×1-mark rubric, gradebook mocks. **Not a database.** |
| Auth / roles | None | Client-side "view switch" only. Faculty data is reachable by the student page (spec violation). |
| Existing exam flow | `draftAssessment()` in `app.js` | Mock: cycles a hardcoded question pool, regex-based heuristic grading (`evaluateSubmission`), localStorage persistence, single "published assessment". |
| Document upload | None | Slides/past exams are seed literals, not files. No PDF/DOCX processing. |
| LLM integration | Transcription only (Gemini Live via server.js) | No text-generation integration. All "AI" behavior is heuristic JS. |
| Course docs & chapters | Not modeled | Course, slides, past exams exist; no syllabus/chapter primitives. |

## 2. Conflicts with the task spec and their resolutions

The task spec assumes an existing production platform with server-side DB, auth, exam
workflows and uploads. None of that exists (the prototype is a localStorage demo), so per
**PART 10** the conflict is resolved as follows — *the safest compatible option*: keep the
prototype's **Moodle shell, course model, rubric concept, lecture capture and faculty/student
role workflows**, but **serverify the platform** so the two required AI features are possible
at all (LLM keys must stay server-side; rubrics must be immutable and auditable; provisional
grades must be invisible to students).

| Spec requirement | Prototype reality | Resolution |
| --- | --- | --- |
| "Reuse existing authentication" | None exists | Build minimal session auth (email + password, cookie session, server-enforced role checks). |
| "Reuse existing database/entities" | localStorage JSON | Build the Prisma/SQLite schema following the prototype's entities — professor(`faculty`), student, course, slides→documents, exam, question, rubric, submission, review — no duplicate concepts. |
| Gemma 4 31B as primary model | No text LLM | Add a **provider abstraction**: `google` (Generative Language REST, model `gemma-4-31b-it`, AI Studio key) and an explicit `test` provider for offline CI. Provider is recorded on every generation/grade row. Never silently substituted. |
| "Existing website" is AAU Moodle shell | Static HTML | Port the shell (`styles.css` + page structures) into the app so both roles keep the same look and navigation. `prototype/` remains runnable standalone for reference. |
| Live lecture transcription (CLAUDE.md P0) | Works via server.js WS proxy | Preserve it: the app runs under a custom Next server that keeps the same `/ws/transcribe` proxy and adds server-backed lecture archive so transcripts survive reloads/restarts. |
| "Do not build a separate application" | — | One application, two role areas, shared DB. |

Stack choice (confirmed by the project owner): **Next.js (App Router) + TypeScript + Prisma (SQLite)**.
LLM access: **official Google Generative Language API with an AI Studio ("Maker Studio") API key**
(added later; the app degrades to a clearly-labelled `test` provider until then).

## 3. Architecture

```
Browser (student page / faculty page, Moodle shell)
      │  fetch + cookies (role enforced server-side)
      ▼
Next.js App Router  ──► /api routes (auth, courses, documents, exams, submissions, reviews)
  TS services:   documents.ts   exam-generation.ts   exam-workflow.ts   grading.ts   results.ts
  validation.ts  (zod)          prompts.ts (versioned)  llm/{google,test}.ts
      ▼
Prisma ─ SQLite (dev.db)      uploads dir (originals)      Gemini Live WS proxy (custom server)
```

Key invariants (from the spec):
- **Rubric immutability:** rubrics are versioned rows; the grade row stores `rubricId` + `rubricVersion`;
  grading always loads the *approved* version — never edits, never regenerates.
- **MCQ = deterministic:** student answer vs answer-key comparison in a server transaction; no LLM.
- **Draft ≠ published:** AI output materializes as a *draft* exam; only an explicit faculty
  **Approve** + **Publish** makes it visible/submittable.
- **Backend-authoritative totals:** every AI grade is schema-validated, criterion-checked,
  evidence-verified (quote checked against the student answer) and re-totaled in code.
- **Audit history:** `GradeAudit` records every AI grade, override, approval, regrade and release;
  nothing is overwritten.

## 4. Data model (logical → Prisma)

| Spec entity | Prisma model |
| --- | --- |
| Exam | `Exam` (+ `generationMeta`, approval info, status machine GENERATING→DRAFT→APPROVED→PUBLISHED) |
| ExamQuestion | `ExamQuestion` (type, order, marks, options/key, expected answer, source refs) |
| WritingQuestionRubric | `Rubric` version + `RubricCriterion` rows (name, description, maxMarks, full-credit requirements, partial-credit guidance, common mistakes, acceptable alternatives) |
| ExamSubmission | `ExamSubmission` (+ per-question `Answer`) |
| WritingQuestionGrade | `WritingQuestionGrade` + `CriterionGrade` (rubric version used, per-criterion marks/evidence/flags, model, prompt version, attempt) |
| GradeAudit | `GradeAudit` (action, actor, previous/new breakdown snapshot, reason, timestamp) |
| Course materials | `Course`, `Chapter`, `Document`, `DocumentSegment` (text chunks keep heading/page locators) |
| Platform (existing prototype concepts) | `User`, `Session`, `Enrollment`, `Lecture`, `TranscriptSegment`, `QaEntry`, `DiscussionTopic` |

## 5. API surface

Faculty: `POST /api/courses/:id/documents` (upload+extract), `POST /api/courses/:id/exams/generate`
(the wizard), exam draft CRUD (`/api/exams/:id/questions/:qid`, rubric edit, regenerate, reorder),
`POST /api/exams/:id/approve`, `POST /api/exams/:id/publish`,
`GET /api/exams/:id/submissions`, `POST /api/submissions/:id/review` (approve / override / regrade / release).

Student: `POST /api/submissions` (start), `POST /api/submissions/:id/submit` (triggers the grading
pipeline), `GET /api/student/results` (**released only**).

Shared: `/api/auth/*`, lectures + private Q&A endpoints (preserved prototype features).

## 6. Generation & grading pipelines

**Generation** (Gemma 4 31B, `gemma-4-31b-it`):
selected sections only → versioned prompts (`MCQ_GEN_V1`, `WRITING_GEN_V1`, `RUBRIC_GEN_V1`) →
strict JSON → zod validation → duplicate detection (token-shingle similarity) → mark totals vs
config → rubric criterion sum === question max (auto-repair attempt once, else item flagged
`NEEDS_RUBRIC_FIX`) → persist draft. Faculty then edits everything and must explicitly approve.

**Grading on submission:**
1. MCQs graded deterministically from the approved key (transaction).
2. Writing answers sent to Gemma with the **exact approved rubric JSON** (delimited as untrusted
   input), expected answer and faculty instructions.
3. Output validated: schema → criterion ID/max checks → per-criterion bounds (clamp + flag) →
   evidence quotes verified against the student's answer → server recalculated total is authoritative.
4. Invalid output → retry once → else grade stored as `REQUIRES_REVIEW`; professor-facing.
5. Professor reviews, can override per criterion (audited), approves, releases.

## 7. Implementation order (PART 9 → actual work)

| Phase | Content |
| --- | --- |
| 1 | This document. |
| 2 | Documents: upload, PDF/DOCX/TXT extraction (with page/heading locators), failure surfacing. |
| 3–4 | Generation wizard config + Gemma MCQ/writing generation server-side. |
| 5–7 | Rubric generation + editor, draft exam editing/validation/approval, versioned persistence. |
| 8–10 | Deterministic MCQ grading, Gemma rubric-locked grading, output validation & evidence checks. |
| 11–12 | Faculty grading dashboard with overrides/audit, student results (released only). |
| 13 | Test suites (generation, grading, security, 16-step E2E), docs, README rewrite. |

## 8. Risks noted up front

- `gemma-4-31b-it` availability/naming **on Google's API** depends on the key the team provides;
  the model id is configurable (`GEMMA_MODEL`) so the served id can be adjusted without code edits.
- Gemma via the Generative Language API historically does not support system instructions or
  native JSON mode → prompts carry instructions in the user turn and JSON is enforced by prompt +
  robust extraction + server-side validation (never trusted blindly).
- The prototype's Ambiguous AI / study-plan integration is out of scope for this task and is not
  ported; lecture transcription, archive, private Q&A, materials, discussion topics and gradebook
  ARE preserved as server-backed features.
