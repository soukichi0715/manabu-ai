"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

function getOrCreateDeviceId() {
  const key = "manabu_device_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `dev-${Date.now()}`;
    localStorage.setItem(key, id);
  }
  return id;
}

export default function Home() {
  const [deviceId, setDeviceId] = useState("");

  useEffect(() => {
    setDeviceId(getOrCreateDeviceId());
  }, []);

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 flex justify-center px-2 py-6">
      <div className="w-full max-w-2xl bg-white border border-slate-200 rounded-2xl shadow-md p-6">
        <h1 className="text-2xl font-bold text-slate-900">
          まなぶ先生AI（プロトタイプ）
        </h1>
        <p className="text-sm text-slate-500 mt-2">
          使いたい機能を選んでください。
        </p>

        <div className="mt-4 flex flex-col gap-3">
          <Link
            href="/consult"
            className="px-4 py-3 rounded-xl bg-blue-600 text-white font-semibold text-sm text-center shadow-sm"
          >
            相談モードへ
          </Link>

          <Link
            href="/analyze"
            className="px-4 py-3 rounded-xl bg-slate-900 text-white font-semibold text-sm text-center shadow-sm"
          >
            分析モードへ
          </Link>
        </div>

        <div className="mt-4 text-xs text-slate-400">
          ID: {deviceId ? deviceId.slice(0, 8) + "…" : "生成中…"}
        </div>
      </div>
    </main>
  );
}
