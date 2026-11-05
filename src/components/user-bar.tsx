"use client";
import { useRouter } from "next/navigation";

export function UserBar({ user, left }: { user: { name: string; role: string }; left: string }) {
  const router = useRouter();
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }
  return (
    <div className="utility-bar">
      <div className="brand">
        <span>AAU Moodle</span>
        <span className="cc-badge">Course Companion</span>
        <span className="hint">{left} view</span>
      </div>
      <div className="user-chip">
        <span className="user-pill">👤 {user.name}</span>
        <button className="pill-btn ghost" onClick={logout}>Sign out</button>
      </div>
    </div>
  );
}
