"use client";
import { useState } from "react";

interface Chapter { id: string; title: string; shortId: string; }
interface Doc { id: string; title: string; kind: string; status: string; }

export function ExamWizard({ courseId, chapters, docs, onDone }: { courseId: string; chapters: Chapter[]; docs: Doc[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warns, setWarns] = useState<string[]>([]);
  const cfgs = ["", "", "", "", ""];
  void cfgs;
  const [form, setForm] = useState({
    title: "Midterm Exam — Newton's Laws",
    durationMinutes: 90,
    difficulty: "mixed",
    includeSyllabus: true,
    selectedChapterIds: chapters.map((c) => c.id),
    additionalMaterialDocumentIds: [] as string[],
    instructions: "Answer all questions. Show your reasoning for written answers.",
    mcqCount: 10,
    mcqMarks: 2,
    writingCount: 3,
    writingMarks: 10,
    declaredTotalMarks: 50,
  });

  const computed = form.mcqCount * form.mcqMarks + form.writingCount * form.writingMarks;
  const mismatch = Math.abs(computed - form.declaredTotalMarks) > 1e-9;

  async function generate() {
    setBusy(true); setErr(null); setWarns([]);
    try {
      const res = await fetch(`/api/faculty/courses/${courseId}/exams/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await res.json();
      if (!res.ok) {
        setErr(j.error + (j.details ? "\n" + JSON.stringify(j.details, null, 1) : ""));
      } else {
        setWarns(j.warnings ?? []);
        setOpen(false);
        onDone();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const failedDocs = docs.filter((d) => d.status === "FAILED");

  return (
    <div>
      <div className="row" style={{ marginBottom: 10, alignItems: "center" }}>
        <div style={{ flex: "0 0 auto" }}>
          <button className="pill-btn" onClick={() => setOpen(true)}>⚡ Generate Exam with AI</button>
        </div>
        <div style={{ flex: 1 }} className="hint">Questions are drafted with <span className="mono">gemma-4-31b-it</span> and always arrive as a <strong>Draft</strong> — you edit, then approve & publish explicitly.</div>
      </div>

      {failedDocs.length > 0 && (
        <div className="callout"><strong>{failedDocs.length} document(s) failed extraction:</strong> {failedDocs.map((d) => d.title).join(", ")} — see the materials panel for reasons.</div>
      )}

      {open && (
        <div className="activity">
          <div className="activity-head"><h3>AI exam draft configuration</h3></div>
          <div className="activity-body">
            {err && <div className="error-box">{err}</div>}
            <div className="row">
              <div style={{ flex: 2 }}><label>Exam title</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
              <div><label>Duration (min)</label><input type="number" value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: Number(e.target.value) })} /></div>
              <div>
                <label>Difficulty mix</label>
                <select value={form.difficulty} onChange={(e) => setForm({ ...form, difficulty: e.target.value })}>
                  {["mixed", "easy", "medium", "hard"].map((d) => <option key={d}>{d}</option>)}
                </select>
              </div>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <div style={{ flex: 3 }}><label>Instructions shown to students</label><input value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} /></div>
              <div><label>Declared total marks</label>
                <input type="number" step="0.5" value={form.declaredTotalMarks} onChange={(e) => setForm({ ...form, declaredTotalMarks: Number(e.target.value) })} />
                {mismatch && <span className="hint" style={{ color: "#a83332" }}>≠ computed {computed}</span>}
              </div>
            </div>

            <div style={{ marginTop: 12, border: "1px dashed var(--border)", padding: 10, borderRadius: 4 }}>
              <label style={{ fontSize: 13, color: "var(--navy)", fontWeight: 600 }}>Source selection — questions come ONLY from what you select here</label>
              <div style={{ marginTop: 6 }}>
                <label style={{ display: "inline-flex", gap: 6, alignItems: "center", marginRight: 14 }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={form.includeSyllabus} onChange={(e) => setForm({ ...form, includeSyllabus: e.target.checked })} />
                  Include syllabus as extra reference
                </label>
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                {chapters.map((c) => (
                  <label key={c.id} className="chip" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      checked={form.selectedChapterIds.includes(c.id)}
                      onChange={(e) => setForm({
                        ...form,
                        selectedChapterIds: e.target.checked ? [...form.selectedChapterIds, c.id] : form.selectedChapterIds.filter((x) => x !== c.id),
                      })}
                    />
                    {c.shortId}: {c.title}
                  </label>
                ))}
              </div>
            </div>

            <div className="row" style={{ marginTop: 12 }}>
              <div><label>MCQ count</label><input type="number" value={form.mcqCount} onChange={(e) => setForm({ ...form, mcqCount: Number(e.target.value) })} /></div>
              <div><label>Marks per MCQ</label><input type="number" step="0.5" value={form.mcqMarks} onChange={(e) => setForm({ ...form, mcqMarks: Number(e.target.value) })} /></div>
              <div><label>Writing count</label><input type="number" value={form.writingCount} onChange={(e) => setForm({ ...form, writingCount: Number(e.target.value) })} /></div>
              <div><label>Marks per writing Q</label><input type="number" step="0.5" value={form.writingMarks} onChange={(e) => setForm({ ...form, writingMarks: Number(e.target.value) })} /></div>
            </div>

            <div style={{ marginTop: 14 }}>
              <button className="pill-btn" onClick={generate} disabled={busy || mismatch}>
                {busy ? "Generating draft (LLM working)…" : `Generate ${form.mcqCount} MCQ + ${form.writingCount} writing draft`}
              </button>
              <button className="pill-btn ghost" style={{ marginLeft: 8 }} onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
              {busy && <div className="hint" style={{ marginTop: 8 }}>Calling gemma-4-31b-it: MCQ batch → writing batch → per-question rubric drafts. Draft only — nothing is published.</div>}
            </div>
          </div>
        </div>
      )}
      {warns.length > 0 && (
        <div className="callout"><strong>Generation warnings:</strong><ul style={{ margin: "6px 0 0 16px" }}>{warns.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
      )}
    </div>
  );
}
