"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function ParentLoginPage() {
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
      setError("生徒IDまたはパスワードが正しくありません");
      setLoading(false);
      return;
    }

    router.push("/report");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm bg-white p-6 rounded-xl shadow">
        <h1 className="text-lg font-bold mb-2">保護者ログイン</h1>

        <p className="text-sm text-gray-600 mb-4">
          塾の個人ページで使用している<br />
          生徒IDとパスワードを入力してください
        </p>

        <div className="space-y-4">
          <input
            type="text"
            placeholder="例：S123456"
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
            className="w-full bg-blue-600 text-white py-2 rounded-md disabled:opacity-50"
          >
            {loading ? "ログインしています…" : "ログイン"}
          </button>
        </div>

        <p className="text-xs text-gray-500 mt-4">
          ID・パスワードが分からない場合は、<br />
          通われている校舎へお問い合わせください
        </p>
      </div>
    </div>
  );
}
