"use client";
import { useCallback, useEffect, useState } from "react";

interface Doc { id: string; title: string; kind: string; status: string; extractionError: string | null; pageCount: number | null; wordCount: number | null; chapterId: string | null; }
interface Chapter { id: string; title: string; shortId: string; order: number; }
interface ExamLite { id: string; title: string; status: string; _count: { questions: number; submissions: number }; isAiGenerated: boolean }
interface Data { course: { id: string; code: string; title: string; unit: string | null; description: string | null }; students: Array<{ id: string; name: string; email: string }> }

export function MaterialPanel({ courseId }: { courseId: string }) {
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [documents, setDocuments] = useState<Doc[]>([]);
  const [data, setDataState] = useState<Data | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [newChapter, setNewChapter] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/faculty/courses/${courseId}`);
    const j = await res.json();
    if (res.ok) {
      setChapters(j.course.chapters);
      setDocuments(j.course.documents);
      setDataState({ course: { id: j.course.id, code: j.course.code, title: j.course.title, unit: j.course.unit, description: j.course.description }, students: j.students });
      void data; // no-op ref
    } else setErr(j.error);
  }, [courseId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
    const t = setInterval(load, 2500); // polling while extraction/generation runs
    return () => clearInterval(t);
  }, [load]);

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true); setErr(null); setMsg(null);
    const res = await fetch(`/api/faculty/courses/${courseId}/documents`, { method: "POST", body: form });
    const j = await res.json();
    setBusy(false);
    if (!res.ok) setErr(j.error || "Upload failed");
    else { setMsg(`Uploaded "${j.document.title}" — extracting text…`); (e.target as HTMLFormElement).reset(); load(); }
  }

  async function addChapter() {
    if (!newChapter.trim()) return;
    setErr(null);
    const res = await fetch(`/api/faculty/courses/${courseId}/chapters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: newChapter.trim() }),
    });
    const j = await res.json();
    if (!res.ok) setErr(j.error || "Could not add chapter");
    else { setNewChapter(""); load(); }
  }

  return (
    <div>
      {err && <div className="error-box">{err}</div>}
      {msg && <div className="ok-box">{msg}</div>}
      <div className="activity">
        <div className="activity-head"><h3>Course materials — syllabus & chapters</h3></div>
        <div className="activity-body">
          <form onSubmit={upload} className="row" encType="multipart/form-data">
            <div><label>File (PDF / DOCX / TXT / MD)</label><input type="file" name="file" required accept=".pdf,.docx,.txt,.md" /></div>
            <div>
              <label>Type</label>
              <select name="kind" defaultValue="CHAPTER">
                <option value="SYLLABUS">Syllabus</option>
                <option value="CHAPTER">Chapter</option>
                <option value="MATERIAL">Material (past exam)</option>
              </select>
            </div>
            <div>
              <label>Link to chapter</label>
              <select name="chapterId">
                <option value="">(none)</option>
                {chapters.map((c) => <option key={c.id} value={c.id}>{c.shortId}: {c.title}</option>)}
              </select>
            </div>
            <div><label>Display title (optional)</label><input name="title" /></div>
            <div style={{ flex: "0 0 auto" }}><button className="pill-btn" disabled={busy}>{busy ? "Uploading…" : "Upload"}</button></div>
          </form>

          <table className="plain" style={{ marginTop: 12 }}>
            <thead><tr><th>Document</th><th>Type</th><th>Status</th><th>Pages</th><th>Words</th></tr></thead>
            <tbody>
              {documents.map((d) => (
                <tr key={d.id}>
                  <td>{d.title}</td>
                  <td className="hint">{d.kind}</td>
                  <td><span className={`status-badge ${(d.status ?? "")}`}>{d.status}</span>{d.extractionError && <div className="hint" style={{ color: "#a83332" }}>{d.extractionError}</div>}</td>
                  <td>{d.pageCount ?? "—"}</td>
                  <td>{d.wordCount ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint" style={{ marginTop: 8 }}>Failed documents never stop generation — they are clearly reported here so you can fix or re-upload them.</p>
        </div>
      </div>
      <div className="activity">
        <div className="activity-head"><h3>Chapters</h3></div>
        <div className="activity-body">
          <ul>
            {chapters.map((c) => <li key={c.id}><strong>{c.shortId}</strong> {c.title}</li>)}
          </ul>
          <div className="row">
            <div><label>New chapter title</label><input value={newChapter} onChange={(e) => setNewChapter(e.target.value)} /></div>
            <div style={{ flex: "0 0 auto" }}><button className="pill-btn ghost" onClick={addChapter}>Save chapter list</button></div>
          </div>
          {data && <p className="hint" style={{ marginTop: 8 }}>{data.students.length} students enrolled: {data.students.map((s) => s.name).join(", ")}</p>}
        </div>
      </div>
    </div>
  );
}
