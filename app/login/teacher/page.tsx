"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function TeacherLoginPage() {
  const router = useRouter();
  const supabase = createClient();

  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setLoading(true);
    setError("");

    const email = `${loginId}@manabu.local`;

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError("ログイン情報が正しくありません");
      setLoading(false);
      return;
    }

    router.push("/analyze");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm bg-white p-6 rounded-xl shadow">
        <h1 className="text-lg font-bold mb-4">講師ログイン</h1>

        <div className="space-y-4">
          <input
            type="text"
            placeholder="ログインID"
            value={loginId}
            onChange={(e) => setLoginId(e.target.value)}
            className="w-full border px-3 py-2 rounded-md"
          />

          <input
            type="password"
            placeholder="パスワード"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full border px-3 py-2 rounded-md"
          />

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          <button
            onClick={handleLogin}
            disabled={loading}
            className="w-full bg-gray-800 text-white py-2 rounded-md disabled:opacity-50"
          >
            {loading ? "ログインしています…" : "ログイン"}
          </button>
        </div>
      </div>
    </div>
  );
}

