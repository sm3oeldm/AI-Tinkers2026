"use client";
import { useEffect, useState } from "react";

interface Q { id: string; order: number; type: string; text: string; marks: number; optionsJson: string | null }

export function ExamRunner({ submissionId }: { submissionId: string }) {
  const [sub, setSub] = useState<{ id: string; examTitle: string; status: string; questions: Q[]; answers: Array<{ questionId: string; selectedOptionId: string | null; text: string | null }>; durationMinutes: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/submissions/${submissionId}`).then((r) => r.json()).then((j) => {
      if (j.error) setErr(j.error);
      else if (j.submission.releasedAt) window.location.href = `/student/results/${submissionId}`;
      else setSub(j.submission);
    });
  }, [submissionId]);

  const inProgress = sub?.status === "IN_PROGRESS";

  async function saveAnswer(questionId: string, patch: { selectedOptionId?: string; text?: string }) {
    await fetch(`/api/submissions/${submissionId}/handin`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId, ...patch }),
    });
  }

  async function submit() {
    setBusy(true); setErr(null);
    const res = await fetch(`/api/submissions/${submissionId}/handin`, { method: "POST" });
    const j = await res.json();
    setBusy(false);
    if (!res.ok) { setErr(j.error); return; }
    window.location.reload();
  }

  if (err) return <div className="layout"><div className="main"><div className="error-box">{err}</div></div></div>;
  if (!sub) return <div className="layout"><div className="main hint">Loading exam…</div></div>;
  if (!inProgress) {
    return (
      <div className="layout"><div className="main">
        <div className="ok-box">Handed in — your submission is <strong>{sub.status}</strong>. Grades appear here only after the faculty releases them.</div>
        <a className="pill-btn ghost" href="/student">← Back to my courses</a>
      </div></div>
    );
  }

  const getAnswer = (qid: string) => sub.answers.find((a) => a.questionId === qid);
  const setLocal = (qid: string, patch: { selectedOptionId?: string | null; text?: string | null }) =>
    setSub({ ...sub, answers: [...sub.answers.filter((a) => a.questionId !== qid), { questionId: qid, selectedOptionId: patch.selectedOptionId ?? getAnswer(qid)?.selectedOptionId ?? null, text: patch.text ?? getAnswer(qid)?.text ?? null }] });

  return (
    <div className="layout">
      <div className="main">
        {err && <div className="error-box">{err}</div>}
        <div className="activity"><div className="activity-head"><h3>{sub.examTitle}</h3><span className="hint">{sub.durationMinutes} min</span></div>
          <div className="activity-body"><p className="hint">Answer everything, then hand in. MCQs are graded automatically by the answer key; written answers are graded against the approved rubric.</p></div>
        </div>
        {sub.questions.map((q) => {
          const a = getAnswer(q.id);
          const opts: Array<{ id: string; text: string }> = q.optionsJson ? JSON.parse(q.optionsJson) : [];
          return (
            <div className="activity" key={q.id}>
              <div className="activity-head"><h3>Q{q.order} · {q.type === "MCQ" ? "Multiple choice" : "Written answer"} · {q.marks} marks</h3></div>
              <div className="activity-body">
                <p>{q.text}</p>
                {q.type === "MCQ" ? (
                  opts.map((o) => (
                    <label key={o.id} style={{ display: "flex", gap: 8, alignItems: "center", margin: "6px 0" }}>
                      <input type="radio" style={{ width: "auto" }} name={q.id} checked={a?.selectedOptionId === o.id}
                        onChange={() => { setLocal(q.id, { selectedOptionId: o.id }); saveAnswer(q.id, { selectedOptionId: o.id }); }} />
                      <span className="mono">{o.id})</span> {o.text}
                    </label>
                  ))
                ) : (
                  <textarea rows={5} placeholder="Type your written answer…" value={a?.text ?? ""}
                    onChange={(e) => setLocal(q.id, { text: e.target.value })}
                    onBlur={(e) => saveAnswer(q.id, { text: e.target.value })} />
                )}
              </div>
            </div>
          );
        })}
        <button className="pill-btn" onClick={submit} disabled={busy}>{busy ? "Handing in…" : "Hand in exam"}</button>
      </div>
    </div>
  );
}
