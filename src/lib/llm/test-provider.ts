// Deterministic offline LLM provider ("test"). It is NOT a model substitute —
// it is an explicit stand-in used when no real provider key is configured, so
// the entire generation/grading pipeline can be exercised offline: unit tests,
// CI, and demos without network. The provider id recorded on every generated
// exam and grade row says exactly what produced the result.
//
// It parses the exact markers emitted by src/lib/prompts.ts and produces
// content-grounded, rubric-faithful JSON with deterministic control hooks:
//   ##INJECT_INVALID        → malformed output (tests schema rejection)
//   ##INJECT_MAX_VIOLATION  → over-award beyond a criterion max (tests clamping)
//   ##INJECT_UNKNOWN_CRIT   → invented criterion id (tests rejection)
//   ##INJECT_FAKE_EVIDENCE  → evidence quote not from the submission (test flags)

import { config } from "../config";
import { LlmError, LlmProvider, LlmPrompt, LlmResult } from "./types";
import { tokenize } from "../text";

interface SectionBlock {
  label: string;
  docId: string;
  heading?: string;
  page?: number;
  text: string;
}

function parseSections(prompt: string): SectionBlock[] {
  const out: SectionBlock[] = [];
  const re = /<<<UNTRUSTED_SOURCE>>>\nSECTION: (.*)\nDOC_ID: (.*)\n(?:HEADING: (.*)\n)?(?:PAGE: (.*)\n)?---\n([\s\S]*?)\n<<<END_UNTRUSTED_SOURCE>>>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    out.push({
      label: m[1],
      docId: m[2],
      heading: m[3] ?? undefined,
      page: m[4] ? Number(m[4]) : undefined,
      text: m[5],
    });
  }
  return out;
}

function parseBlock<T>(prompt: string, tag: string): T | null {
  const re = new RegExp(`<<<${tag}>>>\\n([\\s\\S]*?)\\n<<<END_${tag}>>>`);
  const m = re.exec(prompt);
  if (!m) return null;
  return JSON.parse(m[1]) as T;
}

function parseTagged(prompt: string, tag: string): string | null {
  const re = new RegExp(`<<<${tag}>>>\\n([\\s\\S]*?)\\n<<<END_${tag}>>>`);
  const m = re.exec(prompt);
  return m ? m[1] : null;
}

function firstSentence(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  const i = s.search(/[.!?](\s|$)/);
  return i > 0 ? s.slice(0, i + 1) : s.slice(0, 120);
}

const STOPWORDS = new Set(
  "a an the and or of to in for with on as is are be by that this it its their than then from at into not must you exam question answer criteria criterion marks marks sonst explain content according below each use using per may will would should student source section page heading course".split(" ")
);

function contentTokens(text: string): string[] {
  return tokenize(text).filter((t) => t.length > 3 && !STOPWORDS.has(t));
}

export class TestProvider implements LlmProvider {
  readonly id = "test";
  readonly model = "test-offline-deterministic";
  readonly keyConfigured = false;

  async generate(prompt: LlmPrompt, _options?: { temperature?: number; maxOutputTokens?: number }): Promise<LlmResult> {
    const p = prompt.userPrompt;

    if (p.includes("<<<GRADE_REQUEST>>>")) {
      const text = this.grade(p);
      return { text, provider: this.id, model: this.model, keyConfigured: false };
    }
    if (p.includes("<<<EXAM_CONFIG>>>")) {
      const cfg = parseBlock<{ mcqCount?: number; writingCount?: number; type?: string; marks?: number; difficulty?: string; instructions?: string | null }>(p, "EXAM_CONFIG");
      if (!cfg) throw new LlmError(502, "test provider: EXAM_CONFIG missing");
      if (cfg.type && (cfg.type === "MCQ" || cfg.type === "WRITING")) {
        const sections = parseSections(p);
        const question = this.regeneratedQuestion(p, { type: cfg.type, marks: cfg.marks ?? 0, difficulty: cfg.difficulty ?? null }, sections);
        return { text: JSON.stringify(question), provider: this.id, model: this.model, keyConfigured: false };
      }
      const sections = parseSections(p);
      if (sections.length === 0) throw new LlmError(502, "test provider: no source sections supplied");
      const isMcqCall = cfg.mcqCount != null;
      const json = isMcqCall
        ? { mcqs: this.generateMcqs(cfg.mcqCount!, sections) }
        : { writing_questions: this.generateWriting(cfg.writingCount!, sections) };
      return { text: JSON.stringify(json), provider: this.id, model: this.model, keyConfigured: false };
    }
    if (p.includes("<<<RUBRIC_REQUEST>>>")) {
      const req = parseBlock<{ questionText?: string; marks?: number }>(p, "RUBRIC_REQUEST");
      if (!req) throw new LlmError(502, "test provider: RUBRIC_REQUEST missing");
      return { text: JSON.stringify(this.draftRubric(req.questionText ?? "Question", req.marks ?? 1)), provider: this.id, model: this.model, keyConfigured: false };
    }
    throw new LlmError(502, "test provider: prompt type not recognized");
  }

  // ------------------------------------------------------------------ MCQs --
  private generateMcqs(count: number, sections: SectionBlock[]) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const sec = sections[i % sections.length];
      const gist = firstSentence(sec.text);
      const wrongTopic = sections[(i + 1) % sections.length].label;
      const correctId = ["A", "B", "C", "D"][i % 4];
      const difficulty = i % 3 === 0 ? "easy" : i % 3 === 1 ? "medium" : "hard";
      out.push({
        question: `According to ${sec.label}, which statement is correct? (ref DOC_ID=${sec.docId})`,
        options: [
          { id: "A", text: correctId === "A" ? gist : wrongOption(wrongTopic, 1) },
          { id: "B", text: correctId === "B" ? gist : wrongOption(wrongTopic, 2) },
          { id: "C", text: correctId === "C" ? gist : wrongOption(wrongTopic, 3) },
          { id: "D", text: correctId === "D" ? gist : wrongOption(wrongTopic, 4) },
        ],
        correct_answer_id: correctId,
        explanation: `The source section "${sec.label}" states: ${gist}`,
        source_reference: `${sec.label} (doc ${sec.docId})`,
        difficulty,
      });
    }
    return out;
  }

  // -------------------------------------------------------------- Writing ---
  private generateWriting(count: number, sections: SectionBlock[]) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const sec = sections[(i * 2 + 1) % sections.length];
      out.push({
        question: `In your own words, explain the key idea of ${sec.label} and give an example. (ref DOC_ID=${sec.docId})`,
        expected_answer: `A correct answer explains ${firstSentence(sec.text)} grounded in ${sec.label}. (doc ${sec.docId})`,
        source_reference: `${sec.label} (doc ${sec.docId})`,
        difficulty: i % 2 === 0 ? "medium" : "hard",
      });
    }
    return out;
  }

  private regeneratedQuestion(
    p: string,
    cfg: { type: string; marks: number; difficulty?: string | null },
    sections: SectionBlock[]
  ): unknown {
    const existing = parseTagged(p, "EXISTING_QUESTIONS");
    const sec = sections[0] ?? { label: "Source", docId: "doc", text: "Source material." };
    if (cfg.type === "MCQ") {
      return {
        type: "MCQ",
        data: {
          question: `Regenerated MCQ about ${sec.label}: which statement matches the source? (DOC_ID=${sec.docId})`,
          options: [
            { id: "A", text: firstSentence(sec.text) },
            { id: "B", text: "An incorrect statement unrelated to the source" },
            { id: "C", text: "A statement inverting the source claim" },
            { id: "D", text: "A value not covered in the source material" },
          ],
          correct_answer_id: "A",
          explanation: `Directly stated in ${sec.label}: ${firstSentence(sec.text)}`,
          source_reference: `${sec.label} (doc ${sec.docId})`,
          difficulty: cfg.difficulty ?? "medium",
          ...(existing ? {} : {}),
        },
      };
    }
    return {
      type: "WRITING",
      data: {
        question: `Regenerated writing question about ${sec.label}: explain the concept and apply it. (DOC_ID=${sec.docId})`,
        expected_answer: `Key idea: ${firstSentence(sec.text)} grounded in ${sec.label}.`,
        source_reference: `${sec.label} (doc ${sec.docId})`,
        difficulty: cfg.difficulty ?? "medium",
      },
    };
  }

  // --------------------------------------------------------------- Rubric ---
  private draftRubric(questionText: string, marks: number) {
    // Split into half-unit steps that sum to EXACTLY `marks`.
    const half = Math.max(1, Math.min(5, Math.ceil(marks / 2)));
    const totalHalfUnits = Math.round(marks * 2);
    let per = Math.floor(totalHalfUnits / half);
    if (per < 1) {
      return this.rubricObject(questionText, [marks]);
    }
    const firstHalfUnits = totalHalfUnits - per * (half - 1);
    const prev = [firstHalfUnits, ...Array(half - 1).fill(per)].map((u) => u / 2);
    return this.rubricObject(questionText, prev);
  }

  private rubricObject(questionText: string, marksList: number[]) {
    const topic = contentTokens(questionText).slice(0, 4).join(" ") || "the concept";
    return {
      criteria: marksList.map((m, i) => ({
        name: `Criterion ${i + 1} — ${topic} aspect ${i + 1}`,
        description: `Assesses aspect ${i + 1} of the answer (from "${topic}").`,
        max_marks: m,
        full_credit_requirements: `Clearly and completely addresses aspect ${i + 1} consistent with the question.`,
        partial_credit_requirements: `Partially addresses aspect ${i + 1} (some correct content, some missing or incorrect).`,
        common_mistakes: `Common mistake for aspect ${i + 1}: confusing or omitting the concept in "${topic}".`,
        acceptable_alternatives: `Semantically equivalent phrasings of aspect ${i + 1} are accepted.`,
      })),
    };
  }

  // --------------------------------------------------------------- Grading --
  private grade(p: string): string {
    const rubric = parseBlock<{ max_marks: number; criteria: Array<{ criterion_id: string; name: string; max_marks: number; description: string; full_credit: string; partial_credit: string; common_mistakes?: string | null; acceptable_alternatives?: string | null }> }>(p, "APPROVED_RUBRIC");
    const studentAnswer = parseTagged(p, "STUDENT_ANSWER") ?? "";
    const expected = parseTagged(p, "EXPECTED_ANSWER") ?? "";
    if (!rubric?.criteria?.length) throw new LlmError(502, "test provider: grade request missing rubric");

    if (studentAnswer.includes("##INJECT_INVALID")) {
      return '{"criteria_results":"not-a-list","overall_feedback":broken';
    }

    const forcedMaxViolation = studentAnswer.includes("##INJECT_MAX_VIOLATION");
    const forcedUnknown = studentAnswer.includes("##INJECT_UNKNOWN_CRIT");
    const forcedFakeEvidence = studentAnswer.includes("##INJECT_FAKE_EVIDENCE");

    const ansTokens = new Set(tokenize(studentAnswer));
    const expectedTokens = expected.toLowerCase();

    const results = rubric.criteria.map((c, i) => {
      let awarded = 0;
      const evidence: Array<{ quote: string; explanation: string }> = [];
      let feedback = "";

      const profile = contentTokens(
        [c.description, c.full_credit, c.partial_credit, c.common_mistakes ?? "", c.acceptable_alternatives ?? ""].join(" ")
      );
      const matched = profile.filter((t) => ansTokens.has(t));
      const ratio = profile.length ? matched.length / profile.length : 0;

      if (ratio > 0.12 || (studentAnswer.length > 30 && i === 0)) {
        // 0.5-step bounded award, strongly favoring generous partial credit so
        // semantic-equivalence/plausibility behaviors are reproducible.
        const scaled = Math.max(1, Math.round(c.max_marks * 2 * Math.min(1, Math.max(0.5, ratio * 1.6))) );
        awarded = Math.min(c.max_marks, scaled / 2);
        const kw = matched[0] ?? contentTokens(studentAnswer)[0] ?? "content";
        const idx = studentAnswer.toLowerCase().indexOf(kw);
        evidence.push({
          quote: idx >= 0 ? studentAnswer.slice(Math.max(0, idx - 40), Math.min(studentAnswer.length, idx + 120)).trim() : studentAnswer.slice(0, 120).trim(),
          explanation: `Contains content supporting "${c.name}" (matched: ${kw}).${expectedTokens ? "" : ""}`,
        });
        feedback = awarded >= c.max_marks ? `Fully addresses ${c.name}.` : `Partially addresses ${c.name} (${matched.length}/${profile.length} key points).`;
      } else {
        feedback = `Does not yet address ${c.name}; key idea "${profile[0] ?? c.name}" not present.`;
      }

      if (i === 0 && forcedMaxViolation) awarded = c.max_marks + 2;
      if (i === 0 && forcedUnknown) {
        return {
          criterion_id: "criterion_ghost",
          criterion_name: "Invented criterion",
          maximum_marks: c.max_marks,
          awarded_marks: Math.min(awarded, c.max_marks),
          evidence: [],
          feedback: "invented",
        };
      }
      if (i === 0 && forcedFakeEvidence) {
        evidence.length = 0;
        evidence.push({
          quote: "Although this exact sentence never appeared in the submission, marks are argued here.",
          explanation: "Fabricated support.",
        });
      }

      return {
        criterion_id: c.criterion_id,
        criterion_name: c.name,
        maximum_marks: c.max_marks,
        awarded_marks: awarded,
        evidence,
        feedback,
      };
    });

    const total = results.reduce((a, r) => a + r.awarded_marks, 0);
    return JSON.stringify({
      criteria_results: results,
      overall_feedback: `Deterministic offline evaluation of the submitted answer (total ${total}/${rubric.max_marks}).`,
      requires_human_review: forcedFakeEvidence,
      review_reasons: forcedFakeEvidence ? ["injected-fake-evidence-control"] : [],
      confidence: 0.9,
    });
  }
}

function wrongOption(topic: string, n: number): string {
  const templates = [
    `The source does not state what ${topic} says; this describes a different concept`,
    `This inverts the claim made in the source material about ${topic}`,
    `This uses values or terms that are not present in the source material`,
    `This statement is unsupported: nothing in ${topic} shows this`,
  ];
  return templates[n % templates.length];
}

export function getTestProvider(): TestProvider {
  return new TestProvider();
}
