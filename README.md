// AI-Tinkers2026 — Course Companion platform
// Student & faculty university platform styled after the AAU Moodle shell,
// with AI exam drafting and rubric-locked automatic grading (gemma-4-31b-it).

> See [`docs/INTEGRATION_PLAN.md`](docs/INTEGRATION_PLAN.md) for the analysis of
> the original prototype and how the two AI features integrate. The original
> static prototype is preserved under [`prototype/`](prototype/).

## What is implemented

| Area | Status |
| --- | --- |
| Platform core — faculty/student accounts, cookie sessions, courses, enrollment | Done |
| Course materials — syllabus/chapter upload, PDF & DOCX text extraction with page/heading locators, failure reporting | Done |
| **Generate Exam with AI** — chapter + syllabus selection, MCQ/writing counts & marks, difficulty, per-question config | Done |
| Gemma 4 31B generation (`gemma-4-31b-it`) — MCQs, writing questions, per-question rubric drafts, source references | Done |
| Rubric editor — criteria with marks; criterion sum must equal question marks before approval | Done |
| Draft review — edit questions/options/keys/answers/marks, add/remove/reorder, regenerate single questions, explicit Approve → Publish | Done |
| Rubric versioning — approved rubric is immutable at grading time; grades reference the exact version | Done |
| Deterministic MCQ grading server-side (answer key, no LLM) | Done |
| Gemma writing grading — approved rubric only, JSON validated, criterion bounds clamped+flagged, evidence quotes verified against the student answer, recomputed totals | Done |
| Faculty grading dashboard — per-criterion view, approve/override/regrade/release with `GradeAudit` history | Done |
| Student results — released-only, criterion-level breakdown + feedback | Done |
| Preserved prototype features — live lecture transcription (Gemini Live WS proxy), transcript archive, private Q&A, discussion topics | Done |
| Tests — unit + integration + 16-step end-to-end workflow (`npm test`) | Done (offline `test` provider) |

## Repair / install

```bash
npm install
npm run setup      # prisma db push + seed demo data
npm run dev        # http://localhost:8792
```

## Configuration (`.env`)

| Key | Meaning |
| --- | --- |
| `DATABASE_URL` | SQLite file (`file:../data/dev.db`) |
| `LLM_PROVIDER` | `google` (official Generative Language API) or `test` (deterministic offline provider for CI) |
| `GEMMA_MODEL` | Model id sent to the provider — default `gemma-4-31b-it`; adjust if the served id differs |
| `GOOGLE_AI_API_KEY` | AI Studio ("Maker Studio") key used for generation & grading |
| `GEMINI_API_KEY` | Key for the live transcription proxy (same AI Studio key can be used) |
| `UPLOAD_DIR` | Where uploaded course files are stored |

There is **no silent model substitution**: the configured provider/model id is recorded on
every generated exam and every writing grade (`generationMeta`, `WritingQuestionGrade.model`).
When `LLM_PROVIDER=test` the system is explicit about it in logs and in the stored metadata.

## Demo accounts (seeded)

| Role | Email | Password |
| --- | --- | --- |
| Faculty | `professor@university.edu` | `Password!123` |
| Student | `sara@university.edu` | `Password!123` |
| Student | `yousef@university.edu` | `Password!123` |

Seeded course: **Physics I (PHYS-I-61D)** — Newton's Laws unit, with a syllabus and three
chapter documents (extracted text available for generation). Students are enrolled; the
faculty account owns the course.

## Test suite

```bash
npm test
```

Runs against a disposable SQLite DB (`data/test.db`) with the deterministic `test` LLM
provider — no network, no key needed. The suites cover: chapter-respect, correctness of
answer keys, rubric mark-sum validation, duplicate detection, approval gating, deterministic
MCQ grading, rubric-locked writing grading (partial credit, alternative phrasings, no marks
outside the rubric), evidence verification, invalid-output rejection, override/regrade
auditing, access control (students cannot see provisional grades), and the full 16-step
professor→exam→student→results workflow including "the *edited* rubric is what grading uses".

When a real Google key is configured, point `LLM_PROVIDER=google` and the same services run
live; the offline suites remain the deterministic CI baseline.
