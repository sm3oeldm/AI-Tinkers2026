"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const DEMOS = [
  { role: "Faculty", email: "professor@university.edu" },
  { role: "Student", email: "sara@university.edu" },
  { role: "Student", email: "yousef@university.edu" },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("professor@university.edu");
  const [password, setPassword] = useState("Password!123");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed");
      router.push(data.user.role === "FACULTY" ? "/faculty" : "/student");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-card">
      <div className="utility-bar" style={{ borderRadius: "6px 6px 0 0" }}>
        <div className="brand">
          <span>AAU Moodle</span>
          <span className="cc-badge">Course Companion</span>
        </div>
      </div>
      <div className="block" style={{ borderRadius: "0 0 6px 6px", borderTop: 0 }}>
        <div className="block-head">Sign in</div>
        <div className="block-body">
          {error && <div className="error-box">{error}</div>}
          <form onSubmit={submit}>
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <div style={{ height: 10 }} />
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <div style={{ height: 14 }} />
            <button className="pill-btn" disabled={busy} style={{ width: "100%" }}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
          <p className="hint" style={{ marginTop: 14 }}>
            Seeded demo accounts (password <span className="mono">Password!123</span>):
          </p>
          <div className="chips">
            {DEMOS.map((d) => (
              <button
                key={d.email}
                className="chip"
                style={{ cursor: "pointer", border: "1px solid var(--border)" }}
                onClick={() => {
                  setEmail(d.email);
                  setPassword("Password!123");
                }}
              >
                {d.role}: {d.email}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
