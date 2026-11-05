"use client";
import { useCallback, useEffect, useState } from "react";

interface SubLite { id: string; student: { name: string }; status: string; totalMarks: number | null; maxMarks: number }
interface Detail {
  submission: { id: string; student: { name: string }; status: string; mcqMarks: number | null; writingMarks: number | null; totalMarks: number | null; maxMarks: number; exam: { title: string; courseTitle: string } };
  questions: Array<{
    question: { id: string; order: number; type: string; text: string; marks: number; explanation: string | null; correctAnswerId: string | null; optionsJson: string | null };
    answer: { selectedOptionId: string | null; text: string | null; awardedMarks: number | null; gradedBy: string | null } | null;
    grade: { id: string; status: string; awardedMarks: number; feedback: string | null; evidenceIssuesJson: string | null; reviewReasonsJson: string | null; rubricVersion: number; criteria: Array<{ id: string; criterionId: string; criterionName: string; maxMarks: number; awardedMarks: number; evidenceJson: string; feedback: string; flagged: boolean; flagReasonsJson: string | null }> } | null;
    rubric: { version: number; criteria: Array<{ order: number; name: string; maxMarks: number }> } | null;
  }>;
  audits: Array<{ id: string; action: string; questionId: string | null; actorId: string | null; reason: string | null; previousJson: string | null; newJson: string | null; createdAt: string }>;
}

export default function GradingBoard({ examId }: { examId: string; courseId: string }) {
  const [subs, setSubs] = useState<SubLite[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [reason, setReason] = useState("reviewed against rubric");

  const loadList = useCallback(async () => {
    const res = await fetch(`/api/faculty/exams/${examId}/submissions`);
    const j = await res.json();
    if (res.ok) setSubs(j.submissions); else setErr(j.error);
  }, [examId]);

  useEffect(() => { loadList(); }, [loadList]);

  const open = async (id: string) => {
    setErr(null);
    const res = await fetch(`/api/submissions/${id}/review`);
    const j = await res.json();
    if (res.ok) setDetail(j); else setErr(j.error);
  };

  async function review(body: Record<string, unknown>) {
    if (!detail) return;
    setErr(null); setMsg(null);
    const res = await fetch(`/api/submissions/${detail.submission.id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, reason: (body.reason as string) ?? reason }),
    });
    const j = await res.json();
    if (!res.ok) {
      setErr(typeof j.error === "string" ? j.error + (j.details?.blockers ? "\n" + j.details.blockers.join("\n") : "") : "Action failed");
      return;
    }
    setMsg("Done.");
    await open(detail.submission.id);
    loadList();
  }

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start", padding: "16px 20px 40px", maxWidth: 1400, margin: "0 auto" }}>
      <div style={{ width: 320, flex: "0 0 auto" }}>
        <div className="block">
          <div className="block-head">Submissions</div>
          <div className="block-body">
            {subs.map((s) => (
              <div key={s.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                <a href="#" onClick={(e) => { e.preventDefault(); open(s.id); }}><strong>{s.student.name}</strong></a>
                <div><span className={`status-badge ${s.status}`}>{s.status}</span> <span className="hint">{s.totalMarks}/{s.maxMarks}</span></div>
              </div>
            ))}
            {subs.length === 0 && <p className="hint">No submissions yet.</p>}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {err && <div className="error-box">{err}</div>}
        {msg && <div className="ok-box">{msg}</div>}
        {!detail && <div className="callout">Select a submission to review AI grading results, evidence and audit history.</div>}
        {detail && (
          <div>
            <div className="activity">
              <div className="activity-head">
                <h3>{detail.submission.student.name} — {detail.submission.exam.title}</h3>
                <span className={`status-badge ${detail.submission.status}`}>{detail.submission.status}</span>
              </div>
              <div className="activity-body">
                <p><strong>Total: {detail.submission.totalMarks ?? "—"}/{detail.submission.maxMarks}</strong> (MCQ {detail.submission.mcqMarks ?? "—"} · Writing {detail.submission.writingMarks ?? "—"})</p>
                <div className="row">
                  <div><label>Audit note (recorded with every action)</label><input value={reason} onChange={(e) => setReason(e.target.value)} /></div>
                  <div style={{ flex: "0 0 auto" }}>
                    <button className="pill-btn" onClick={() => review({ action: "approve_all" })} disabled={detail.submission.status !== "PROVISIONAL"}>Approve all</button>
                    <button className="pill-btn secondary" style={{ marginLeft: 6 }} onClick={() => review({ action: "release" })} disabled={detail.submission.status !== "APPROVED"}>Release to student</button>
                  </div>
                </div>
              </div>
            </div>

            {detail.questions.map((entry) => {
              const { question: q, answer, grade } = entry;
              const criteria = grade?.criteria ?? [];
              const [overrides, setOverrides] = [null, null];
              void overrides; void setOverrides;
              return (
                <div className="activity" key={q.id}>
                  <div className="activity-head"><h3>Q{q.order} · {q.type === "MCQ" ? "MCQ" : "Written"} · {q.marks} marks</h3>
                    {grade && <span className={`status-badge ${grade.status}`}>{grade.status} (rubric v{grade.rubricVersion})</span>}
                  </div>
                  <div className="activity-body">
                    <p>{q.text}</p>
                    {q.type === "MCQ" ? (
                      <p className="hint">Student selected: <strong>{answer?.selectedOptionId ?? "—"}</strong> · key: <strong>{q.correctAnswerId}</strong> · awarded <strong>{answer?.awardedMarks ?? 0}</strong> — graded deterministically from the answer key.</p>
                    ) : (
                      <div>
                        <label>Student answer</label>
                        <div className="callout" style={{ whiteSpace: "pre-wrap" }}>{answer?.text || <em>(no answer)</em>}</div>
                        <p className="hint" style={{ marginTop: 4 }}>
                          Awarded <strong>{grade?.awardedMarks ?? 0}/{q.marks}</strong>
                          {grade?.reviewReasonsJson && ` · review reasons: ${JSON.parse(grade.reviewReasonsJson).join("; ")}`}
                        </p>
                        {grade && (
                          <table className="rubric-table">
                            <thead><tr><th>Criterion</th><th>Max</th><th>Awarded</th><th>Evidence (verified against the submission)</th><th>Flags</th></tr></thead>
                            <tbody>
                              {criteria.map((c) => {
                                const evidence = JSON.parse(c.evidenceJson) as Array<{ quote: string; explanation: string; verified: boolean }>;
                                return (
                                  <tr key={c.id}>
                                    <td><strong>{c.criterionName}</strong><div className="hint">{c.feedback}</div></td>
                                    <td>{c.maxMarks}</td>
                                    <td><OverrideInput criterionId={c.criterionId} max={c.maxMarks} current={c.awardedMarks} onOverride={(arr, fb) => review({ action: "override", questionId: q.id, criterionMarks: arr, feedback: fb })} allCriteria={criteria} /></td>
                                    <td>
                                      {evidence.length === 0 && <span className="hint">—</span>}
                                      {evidence.map((ev, i) => (
                                        <div key={i} style={{ marginBottom: 4 }}>
                                          <span className="chip" style={ev.verified ? {} : { background: "#fdeeee", borderColor: "#e7c2c1", color: "#a83332" }}>{ev.verified ? "verified ✓" : "NOT verifiable ✗"}</span>
                                          <div className="mono">“{ev.quote}”</div>
                                          <div className="hint">{ev.explanation}</div>
                                        </div>
                                      ))}
                                    </td>
                                    <td>{c.flagged ? <span className="hint" style={{ color: "#a83332" }}>{JSON.parse(c.flagReasonsJson ?? "[]").join("; ")}</span> : "—"}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                        <div className="row" style={{ marginTop: 8 }}>
                          <button className="pill-btn ghost" onClick={() => review({ action: "regrade", questionId: q.id })}>Regrade with same rubric</button>
                          <button className="pill-btn ghost" onClick={() => review({ action: "approve_question", questionId: q.id })}>Approve this grade</button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            <div className="activity">
              <div className="activity-head"><h3>Grade audit trail (append-only)</h3></div>
              <div className="activity-body">
                {detail.audits.map((a) => (
                  <div key={a.id} className="hint" style={{ borderBottom: "1px solid var(--border)", padding: "6px 0" }}>
                    <strong>{a.action}</strong> {a.questionId ? `(question ${a.questionId.slice(-4)})` : ""} · {new Date(a.createdAt).toLocaleString()} {a.reason ? `· ${a.reason}` : ""}
                    <div className="mono" style={{ fontSize: 11, color: "#6c757d" }}>{a.previousJson} → {a.newJson}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function OverrideInput({ criterionId, max, current, allCriteria, onOverride }: {
  criterionId: string; max: number; current: number;
  allCriteria: Array<{ criterionId: string; maxMarks: number; awardedMarks: number }>;
  onOverride: (marks: Array<{ criterionId: string; awardedMarks: number }>, feedback: string) => void;
}) {
  const [val, setVal] = useState(current);
  void allCriteria;
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <input type="number" step="0.5" style={{ width: 70 }} value={val} max={max} min={0} onChange={(e) => setVal(Number(e.target.value))} />
      <button className="pill-btn ghost" onClick={() => onOverride(
        allCriteria.map((c) => ({ criterionId: c.criterionId, awardedMarks: c.criterionId === criterionId ? val : c.awardedMarks })),
        "faculty criterion override"
      )}>Set</button>
    </div>
  );
}
