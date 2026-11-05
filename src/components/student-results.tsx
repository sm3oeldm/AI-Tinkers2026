"use client";
import { useEffect, useState } from "react";

interface Breakdown {
  questionId: string; order: number; type: string; question: string; maxMarks: number; awardedMarks: number;
  selectedOption?: string | null; correctOptionText?: string | null;
  criteria?: Array<{ criterionName: string; maxMarks: number; awardedMarks: number; feedback: string }>;
  feedback?: string | null;
}

export function StudentResults({ submissionId }: { submissionId: string }) {
  const [r, setR] = useState<{
    examTitle: string; releasedAt: string; mcqMarks: number; writingMarks: number; totalMarks: number; maxMarks: number; breakdown: Breakdown[];
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/student/results?submissionId=${submissionId}`).then((x) => x.json()).then((j) => {
      if (j.error) setErr(j.error);
      else setR(j.submission);
    });
  }, [submissionId]);

  if (err) return <div className="layout"><div className="main"><div className="error-box">{err}</div></div></div>;
  if (!r) return <div className="layout"><div className="main hint">Loading results…</div></div>;

  return (
    <div className="layout">
      <div className="main">
        <div className="ok-box">Final results — released {new Date(r.releasedAt).toLocaleString()}</div>
        <div className="activity">
          <div className="activity-head"><h3>{r.examTitle}</h3>
            <strong style={{ color: "var(--red)", fontSize: 16 }}>{r.totalMarks} / {r.maxMarks}</strong></div>
          <div className="activity-body">
            <p className="hint">MCQ {r.mcqMarks} · Writing {r.writingMarks}</p>
            {r.breakdown.map((b) => (
              <div className="callout" key={b.questionId} style={{ marginBottom: 10, background: "#fff" }}>
                <strong>Q{b.order} · {b.maxMarks} marks — awarded <span style={{ color: "var(--red)" }}>{b.awardedMarks}</span></strong>
                <p style={{ margin: "6px 0" }}>{b.question}</p>
                {b.type === "MCQ" && <p className="hint">You chose: {b.selectedOption ?? "(no answer)"} · {b.awardedMarks > 0 ? "Correct ✓" : `Correct answer: ${b.correctOptionText}`}</p>}
                {b.criteria && b.criteria.length > 0 && (
                  <table className="rubric-table">
                    <thead><tr><th>Criterion</th><th>Max</th><th>Awarded</th><th>Feedback</th></tr></thead>
                    <tbody>
                      {b.criteria.map((c, i) => (
                        <tr key={i}><td>{c.criterionName}</td><td>{c.maxMarks}</td><td>{c.awardedMarks}</td><td>{c.feedback}</td></tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {b.feedback && <p className="hint" style={{ marginTop: 6 }}>{b.feedback}</p>}
              </div>
            ))}
          </div>
        </div>
        <a className="pill-btn ghost" href="/student">← Back to my courses</a>
      </div>
    </div>
  );
}
