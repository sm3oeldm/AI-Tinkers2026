"use client";
import { useCallback, useEffect, useState } from "react";

interface Exam { id: string; title: string; durationMinutes: number }
interface Data {
  course: { id: string; code: string; title: string; unit: string | null };
  exams: Exam[];
  materials: Array<{ id: string; title: string; kind: string; chapter: { title: string } | null }>;
  lectures: Array<{ id: string; title: string; dateStr: string; status: string; segments: number }>;
  qa: Array<{ id: string; question: string; answer: string; status: string; createdAt: string }>;
  submissions: Array<{ id: string; status: string; exam: { title: string } }>;
}

export function StudentCourse({ courseId }: { courseId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const qaBusy = useState(false)[0];
  void qaBusy;

  const load = useCallback(async () => {
    const res = await fetch(`/api/student/courses/${courseId}`);
    const j = await res.json();
    if (res.ok) setData(j); else setErr(j.error);
  }, [courseId]);
  useEffect(() => { load(); }, [load]);

  async function startExam(examId: string) {
    setErr(null);
    const res = await fetch("/api/submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ examId }) });
    const j = await res.json();
    if (!res.ok) { setErr(j.error); return; }
    window.location.href = `/student/exams/${j.submission.id}`;
  }

  async function ask() {
    if (question.trim().length < 3) return;
    setErr(null);
    const res = await fetch(`/api/courses/${courseId}/qa`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
    const j = await res.json();
    if (res.ok) { setQuestion(""); load(); } else setErr(j.error);
  }

  if (!data) return <div className="layout"><div className="main hint">{err ?? "Loading…"}</div></div>;

  return (
    <div className="layout">
      <div className="side">
        <div className="block"><div className="block-head">Navigation</div><div className="block-body"><ul><li><a href="/student">My courses</a></li><li><strong>{data.course.code}</strong></li></ul></div></div>
      </div>
      <div className="main">
        {err && <div className="error-box">{err}</div>}

        <div className="activity">
          <div className="activity-head"><h3>Contact hours — lectures</h3></div>
          <div className="activity-body">
            <ul>
              {data.lectures.map((l) => (
                <li key={l.id}><strong>{l.dateStr}</strong> — {l.title} <span className="chip">{l.status}</span> <span className="hint">{l.segments} transcript segments</span></li>
              ))}
              {data.lectures.length === 0 && <li className="hint">No lectures recorded yet.</li>}
            </ul>
          </div>
        </div>

        <div className="activity">
          <div className="activity-head"><h3>Quizzes / exams</h3></div>
          <div className="activity-body">
            {data.exams.map((e) => {
              const mine = data.submissions.find((s) => s.exam.title === e.title);
              return (
                <div key={e.id} style={{ marginBottom: 10 }}>
                  <strong>{e.title}</strong> <span className="hint">({e.durationMinutes} min)</span>
                  {mine ? (
                    <div style={{ marginTop: 4 }}>
                      <span className={`status-badge ${mine.status}`}>{mine.status}</span>
                      {mine.status === "PUBLISHED" && <a className="pill-btn ghost" style={{ marginLeft: 8 }} href={`/student/results/${mine.id}`}>View results</a>}
                    </div>
                  ) : (
                    <div style={{ marginTop: 4 }}><button className="pill-btn" onClick={() => startExam(e.id)}>Take exam</button></div>
                  )}
                </div>
              );
            })}
            {data.exams.length === 0 && <p className="hint">No published exams right now.</p>}
          </div>
        </div>

        <div className="activity">
          <div className="activity-head"><h3>Ask the class assistant (private, source-chipped)</h3></div>
          <div className="activity-body">
            <div className="row">
              <div style={{ flex: 3 }}><input placeholder="e.g. What did we say about labeled training data?" value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()} /></div>
              <div style={{ flex: "0 0 auto" }}><button className="pill-btn" onClick={ask}>Ask</button></div>
            </div>
            {data.qa.map((q) => (
              <div key={q.id} style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                <strong>{q.question}</strong>
                <p style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>{q.answer}</p>
                <span className={`status-badge ${q.status === "SUPPORTED" ? "APPROVED" : "REQUIRES_REVIEW"}`}>{q.status}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="activity">
          <div className="activity-head"><h3>Course materials</h3></div>
          <div className="activity-body">
            <ul>{data.materials.map((m) => <li key={m.id}>{m.title} <span className="chip">{m.kind}{m.chapter ? ` · ${m.chapter.title}` : ""}</span></li>)}</ul>
            <p className="hint">Answer keys and past exams marked non-released are not visible to students.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
