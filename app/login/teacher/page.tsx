"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function TeacherLoginPage() {
  const router = useRouter();
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);

    const r = await fetch("/api/login/teacher", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, password }),
    });

    setLoading(false);
  
    if (!r.ok) {
      setErr("IDまたはパスワードが違います");
      return;
    }

    router.replace("/analyze");
  }

  return (
    <div style={{ maxWidth: 420, margin: "80px auto" }}>
      <h2>講師ログイン</h2>
      <form onSubmit={onSubmit}>
        <div style={{ marginTop: 12 }}>
          <label>ID</label>
          <input
  value={id}
  onChange={(e) => setId(e.target.value)}
  placeholder="講師ID"
  style={inputStyle}
/>

        </div>
        <div style={{ marginTop: 12 }}>
          <label>パスワード</label>
          <input
  type="password"
  value={password}
  onChange={(e) => setPassword(e.target.value)}
  placeholder="パスワード"
  style={inputStyle}
/>

        </div>

        {err && <p style={{ color: "red", marginTop: 12 }}>{err}</p>}

        <button disabled={loading} style={{ marginTop: 16, width: "100%" }}>
          {loading ? "ログイン中..." : "ログイン"}
        </button>
      </form>

      <p style={{ marginTop: 12, color: "#666" }}>（デモ用：test / test）</p>
    </div>
  );
}
