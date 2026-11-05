"use client";
import { useCallback, useEffect, useState } from "react";

interface Criterion { id: string; order: number; name: string; description: string; maxMarks: number; fullCredit: string; partialCredit: string; commonMistakes: string | null; acceptableAlternatives: string | null }
interface Rubric { id: string; version: number; status: string; criteria: Criterion[] }
interface Question { id: string; order: number; type: string; text: string; marks: number; optionsJson: string | null; correctAnswerId: string | null; explanation: string | null; expectedAnswer: string | null; difficulty: string | null; needsRubricFix: boolean; rubricVersions?: Rubric[] }
interface ExamData { id: string; title: string; status: string; instructions: string | null; durationMinutes: number; questions: Question[]; generationMeta: string | null; approvedAt: string | null }

export function ExamEditor({ courseId, examId }: { courseId: string; examId: string }) {
  const [exam, setExam] = useState<ExamData | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [validation, setValidation] = useState<{ ok: boolean; issues: string[]; totalMarks: number } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/faculty/exams/${examId}`);
    const j = await res.json();
    if (res.ok) setExam(j.exam); else setErr(j.error);
  }, [examId]);

  useEffect(() => { load(); }, [load]);

  async function post(url: string, body: unknown) {
    setErr(null); setMsg(null);
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json();
    if (!res.ok) { setErr(typeof j.error === "string" ? j.error + (j.details?.issues ? "\n" + j.details.issues.join("\n") : "") : "Request failed"); return null; }
    return j;
  }

  const editable = exam?.status === "DRAFT";

  async function saveQuestion(q: Question, opts: unknown) {
    await post(`/api/faculty/exams/${examId}/questions/${q.id}`, opts);
    setMsg(`Question ${q.order} saved.`);
    load();
  }

  async function saveRubric(q: Question) {
    const rubric = q.rubricVersions?.[0];
    if (!rubric) return;
    await post(`/api/faculty/exams/${examId}/questions/${q.id}`, {
      rubric: {
        criteria: rubric.criteria.map((c) => ({
          name: c.name, description: c.description, maxMarks: Number(c.maxMarks),
          fullCredit: c.fullCredit, partialCredit: c.partialCredit,
          commonMistakes: c.commonMistakes, acceptableAlternatives: c.acceptableAlternatives,
        })),
      },
    });
    setMsg(`Rubric for question ${q.order} replaced in draft version ${rubric.version}.`);
    load();
  }

  async function regen(q: Question) {
    const j = await post(`/api/faculty/exams/${examId}/actions`, { action: "regenerate", questionId: q.id });
    if (j) { setMsg(`Question ${q.order} regenerated.`); load(); }
  }

  async function act(action: string) {
    const j = await post(`/api/faculty/exams/${examId}/actions`, { action });
    if (j) {
      if (action === "validate") setValidation(j);
      load();
    }
  }

  if (!exam) return <div className="activity"><div className="activity-body hint">Loading editor…</div></div>;

  const critSum = (q: Question) => (q.rubricVersions?.[0]?.criteria ?? []).reduce((a, c) => a + Number(c.maxMarks), 0);

  return (
    <div>
      {err && <div className="error-box">{err}</div>}
      {msg && <div className="ok-box">{msg}</div>}
      <div className="activity"><div className="activity-head"><h3>{exam.title}</h3>
        <span className={`status-badge ${exam.status}`}>{exam.status}</span></div>
        <div className="activity-body">
          <p className="hint">{exam.questions.length} questions · {exam.durationMinutes} min {validation ? `· computed total: ${validation.totalMarks}` : ""}</p>
          <div className="row">
            <button className="pill-btn ghost" onClick={() => act("validate")}>Validate</button>
            <button className="pill-btn" onClick={() => act("approve")} disabled={!editable}>Approve (locks rubrics)</button>
            <button className="pill-btn secondary" onClick={() => act("publish")} disabled={exam.status !== "APPROVED"}>Publish for students</button>
          </div>
          {validation && !validation.ok && <div className="error-box" style={{ marginTop: 10 }}>{validation.issues.join("\n")}</div>}
          {validation?.ok && <div className="ok-box" style={{ marginTop: 10 }}>Validation passed — {exam.questions.length} questions, total {validation.totalMarks} marks.</div>}
        </div>
      </div>

      {exam.questions.map((q) => {
        const opts: Array<{ id: string; text: string }> = q.optionsJson ? JSON.parse(q.optionsJson) : [];
        const rubric = q.rubricVersions?.[0];
        return (
          <div className="activity" key={q.id}>
            <div className="activity-head">
              <h3>Q{q.order} · {q.type === "MCQ" ? "Multiple choice" : "Written answer"} · {q.marks} marks</h3>
              <span className="hint">{q.difficulty ?? ""} {q.needsRubricFix && q.type === "WRITING" ? " · NEEDS RUBRIC FIX" : ""}</span>
            </div>
            <div className="activity-body">
              {q.type === "MCQ" ? (
                <div>
                  <textarea rows={2} value={q.text} disabled={!editable} onChange={(e) => setExam({ ...exam, questions: exam.questions.map((x) => x.id === q.id ? { ...x, text: e.target.value } : x) })} />
                  <table className="plain" style={{ margin: "8px 0" }}>
                    <tbody>
                      {opts.map((o, i) => (
                        <tr key={o.id}>
                          <td style={{ width: 40 }} className="mono">{o.id}</td>
                          <td><input disabled={!editable} value={opts[i].text} onChange={(e) => { const next = [...opts]; next[i] = { ...o, text: e.target.value }; void 0; void next; setExam({ ...exam, questions: exam.questions.map((x) => x.id === q.id ? { ...x, optionsJson: JSON.stringify(next) } : x) }); }} /></td>
                          <td style={{ width: 90 }}>
                            <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                              <input type="radio" style={{ width: "auto" }} name={`key-${q.id}`} checked={q.correctAnswerId === o.id} disabled={!editable} onChange={() => setExam({ ...exam, questions: exam.questions.map((x) => x.id === q.id ? { ...x, correctAnswerId: o.id } : x) })} />
                              key
                            </label>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <textarea rows={2} placeholder="Explanation (faculty-facing)" disabled={!editable} value={q.explanation ?? ""} onChange={(e) => setExam({ ...exam, questions: exam.questions.map((x) => x.id === q.id ? { ...x, explanation: e.target.value } : x) })} />
                  <div style={{ marginTop: 8 }}>
                    <button className="pill-btn ghost" disabled={!editable} onClick={() => saveQuestion(q, { text: q.text, options: JSON.parse(q.optionsJson ?? "[]"), correctAnswerId: q.correctAnswerId, explanation: q.explanation, marks: q.marks })}>Save MCQ</button>
                    <button className="pill-btn ghost" style={{ marginLeft: 6 }} disabled={!editable} onClick={() => regen(q)}>Regenerate question</button>
                    <button className="pill-btn ghost" style={{ marginLeft: 6, color: "#a83332" }} disabled={!editable} onClick={async () => { await fetch(`/api/faculty/exams/${examId}/questions/${q.id}`, { method: "DELETE" }); load(); }}>Remove</button>
                  </div>
                </div>
              ) : (
                <div>
                  <textarea rows={3} disabled={!editable} value={q.text} onChange={(e) => setExam({ ...exam, questions: exam.questions.map((x) => x.id === q.id ? { ...x, text: e.target.value } : x) })} />
                  <div style={{ marginTop: 8 }}>
                    <label>Faculty-only expected answer (key concepts)</label>
                    <textarea rows={3} disabled={!editable} value={q.expectedAnswer ?? ""} onChange={(e) => setExam({ ...exam, questions: exam.questions.map((x) => x.id === q.id ? { ...x, expectedAnswer: e.target.value } : x) })} />
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <label>Rubric (criterion marks must sum to question marks {q.marks} — currently {critSum(q)})</label>
                    <table className="rubric-table">
                      <thead><tr><th style={{ width: 130 }}>Name</th><th>Description</th><th style={{ width: 60 }}>Max</th><th>Full credit</th><th>Partial credit</th></tr></thead>
                      <tbody>
                        {(rubric?.criteria ?? []).map((c) => (
                          <tr key={c.id}>
                            <td><input disabled={!editable} value={c.name} onChange={(e) => { if (!rubric) return; const next = [...rubric.criteria]; const idx = next.indexOf(c); next[idx] = { ...c, name: e.target.value }; setExam({ ...exam, questions: exam.questions.map((x) => x.id === q.id && x.rubricVersions ? { ...x, rubricVersions: x.rubricVersions.map((r) => r.id === rubric.id ? { ...r, criteria: next } : r) } : x) }); }} /></td>
                            <td><input disabled={!editable} value={c.description} onChange={(e) => updCriterion(exam, setExam, q, rubric!, c.id, { description: e.target.value })} /></td>
                            <td><input type="number" step="0.5" disabled={!editable} value={c.maxMarks} onChange={(e) => updCriterion(exam, setExam, q, rubric!, c.id, { maxMarks: Number(e.target.value) })} /></td>
                            <td><input disabled={!editable} value={c.fullCredit} onChange={(e) => updCriterion(exam, setExam, q, rubric!, c.id, { fullCredit: e.target.value })} /></td>
                            <td><input disabled={!editable} value={c.partialCredit} onChange={(e) => updCriterion(exam, setExam, q, rubric!, c.id, { partialCredit: e.target.value })} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ marginTop: 8 }}>
                      <button className="pill-btn ghost" disabled={!editable} onClick={() => saveRubric(q)}>Save rubric edits</button>
                      <button className="pill-btn ghost" style={{ marginLeft: 6 }} disabled={!editable} onClick={() => regen(q)}>Regenerate writing question</button>
                      <button className="pill-btn ghost" style={{ marginLeft: 6, color: "#a83332" }} disabled={!editable} onClick={async () => { await fetch(`/api/faculty/exams/${examId}/questions/${q.id}`, { method: "DELETE" }); load(); }}>Remove</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function updCriterion(
  exam: ExamData,
  setExam: (x: ExamData) => void,
  q: Question,
  rubric: Rubric,
  criterionId: string,
  patch: Partial<Criterion>
) {
  const examQuestions = exam.questions.map((x) => {
    if (x.id !== q.id || !x.rubricVersions) return x;
    return {
      ...x,
      rubricVersions: x.rubricVersions.map((r) =>
        r.id === rubric.id ? { ...r, criteria: r.criteria.map((c) => (c.id === criterionId ? { ...c, ...patch } : c)) } : r
      ),
    };
  });
  setExam({ ...exam, questions: examQuestions });
}
