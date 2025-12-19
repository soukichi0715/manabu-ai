"use client";

import Link from "next/link";
import { ChangeEvent, FormEvent, useEffect, useState } from "react";

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

type Cause =
  | "time"
  | "read"
  | "diagram"
  | "calc"
  | "hard";
type Impression =
  | "rush"
  | "careful"
  | "focus"
  | "grit";

export default function AnalyzePage() {
  const [deviceId, setDeviceId] = useState("");

  const [pdf1, setPdf1] = useState<File | null>(null);
  const [pdf2, setPdf2] = useState<File | null>(null);

  const [causes, setCauses] = useState<Cause[]>([]);
  const [impression, setImpression] = useState<Impression | "">("");

  const [loading, setLoading] = useState(false);
  const [resultInternal, setResultInternal] = useState<string>("");
  const [resultParent, setResultParent] = useState<string>("");

  const [view, setView] = useState<"internal" | "parent">("internal");

  useEffect(() => {
    setDeviceId(getOrCreateDeviceId());
  }, []);

  function handlePdf1(e: ChangeEvent<HTMLInputElement>) {
    setPdf1(e.target.files?.[0] ?? null);
  }
  function handlePdf2(e: ChangeEvent<HTMLInputElement>) {
    setPdf2(e.target.files?.[0] ?? null);
  }

  function toggleCause(v: Cause) {
    setCauses((prev) => {
      const has = prev.includes(v);
      if (has) return prev.filter((x) => x !== v);
      // 最大2つ
      if (prev.length >= 2) return prev;
      return [...prev, v];
    });
  }

  async function handleAnalyze(e?: FormEvent) {
    if (e) e.preventDefault();
    if (loading) return;

    // MVP: まずはUI完成優先。後で /api/analyze に差し替える
    setLoading(true);
    try {
      // ここで本当は FormData でPDFを送る
      // const fd = new FormData(); fd.append("pdf1", pdf1!); fd.append("pdf2", pdf2!); ...

      const prettyCause =
        causes.length === 0
          ? "（講師チェック未入力）"
          : causes.join(", ");
      const prettyImp = impression || "（未入力）";

      setResultInternal(
        `【講師用まとめ（デモ）】
- PDF①：${pdf1?.name ?? "未選択"}
- PDF②：${pdf2?.name ?? "未選択"}
- 失点主因：${prettyCause}
- 解き方印象：${prettyImp}

次に、OCRで「設問別：単元/正答率/本人○×△」と
「年間推移：偏差値/点数/単元履歴」を抽出し、
“落とすべきでない問題の取りこぼし”と“構造的弱点”を切り分けます。`
      );

      setResultParent(
        `【保護者用（デモ）】
今回の結果は「理解不足」よりも、
“取れる問題を取り切るための手順”に改善余地がありそうです。

今週は「見直し（または整理）を必ず1回入れる」を最優先にしましょう。`
      );
    } finally {
      setLoading(false);
    }
  }

  const disabledAnalyze = !pdf1 || !pdf2 || !deviceId;

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 flex justify-center px-2 py-4">
      <div className="w-full max-w-4xl bg-white border border-slate-200 rounded-2xl shadow-md overflow-hidden">
        <header className="px-5 py-3 border-b border-slate-200 bg-slate-50/80 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <h1 className="text-xl md:text-2xl font-bold text-slate-900">
              分析モード
            </h1>
            <Link
              href="/consult"
              className="text-xs md:text-sm px-3 py-1 rounded-lg border border-slate-300 bg-white text-slate-700"
            >
              相談へ
            </Link>
            <span className="ml-auto text-[10px] md:text-xs text-slate-400">
              ID: {deviceId ? deviceId.slice(0, 8) + "…" : "生成中…"}
            </span>
          </div>
          <p className="text-xs md:text-sm text-slate-500 mt-1">
            PDF①（設問別）＋PDF②（年間推移）を読み込み、講師の30秒チェックを足して分析します。
          </p>
        </header>

        <form onSubmit={handleAnalyze} className="p-4 md:p-5 space-y-4">
          {/* PDFアップロード */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="border border-slate-200 rounded-xl p-3 bg-slate-50">
              <div className="text-sm font-semibold text-slate-800">
                PDF①：設問別（単元＋正答率＋本人○×△）
              </div>
              <input
                type="file"
                accept="application/pdf"
                onChange={handlePdf1}
                className="mt-2 text-xs file:mr-2 file:px-3 file:py-1 file:rounded-md file:border file:border-slate-300 file:bg-white file:cursor-pointer"
              />
              <div className="mt-1 text-xs text-slate-500 truncate">
                {pdf1 ? `選択中：${pdf1.name}` : "未選択"}
              </div>
            </div>

            <div className="border border-slate-200 rounded-xl p-3 bg-slate-50">
              <div className="text-sm font-semibold text-slate-800">
                PDF②：年間推移＋出題単元
              </div>
              <input
                type="file"
                accept="application/pdf"
                onChange={handlePdf2}
                className="mt-2 text-xs file:mr-2 file:px-3 file:py-1 file:rounded-md file:border file:border-slate-300 file:bg-white file:cursor-pointer"
              />
              <div className="mt-1 text-xs text-slate-500 truncate">
                {pdf2 ? `選択中：${pdf2.name}` : "未選択"}
              </div>
            </div>
          </div>

          {/* 講師チェック */}
          <div className="border border-slate-200 rounded-xl p-3">
            <div className="text-sm font-semibold text-slate-800">
              講師チェック（30秒）
            </div>

            <div className="mt-3">
              <div className="text-xs font-semibold text-slate-700">
                失点主因（最大2つ）
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {[
                  ["time", "時間切れ"],
                  ["read", "条件読み落とし"],
                  ["diagram", "図・整理不足"],
                  ["calc", "計算ミス"],
                  ["hard", "難問に時間を使いすぎ"],
                ].map(([k, label]) => {
                  const key = k as Cause;
                  const active = causes.includes(key);
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => toggleCause(key)}
                      className={`px-3 py-1 rounded-lg border text-xs ${
                        active
                          ? "bg-slate-900 text-white border-slate-900"
                          : "bg-white text-slate-700 border-slate-300"
                      }`}
                      title="最大2つまで"
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                ※最大2つまで（3つ目は選べない仕様）
              </div>
            </div>

            <div className="mt-4">
              <div className="text-xs font-semibold text-slate-700">
                解き方印象（1つ）
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {[
                  ["rush", "急ぎすぎ"],
                  ["careful", "慎重すぎ"],
                  ["focus", "集中が切れやすい"],
                  ["grit", "粘りはある"],
                ].map(([k, label]) => {
                  const key = k as Impression;
                  const active = impression === key;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setImpression(active ? "" : key)}
                      className={`px-3 py-1 rounded-lg border text-xs ${
                        active
                          ? "bg-blue-600 text-white border-blue-600"
                          : "bg-white text-slate-700 border-slate-300"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* 実行ボタン */}
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={disabledAnalyze || loading}
              className="px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold disabled:bg-slate-400 disabled:cursor-not-allowed shadow-sm"
            >
              {loading ? "分析中…" : "分析生成"}
            </button>

            <button
              type="button"
              onClick={() => {
                setPdf1(null);
                setPdf2(null);
                setCauses([]);
                setImpression("");
                setResultInternal("");
                setResultParent("");
              }}
              className="px-4 py-2 rounded-xl border border-slate-300 bg-white text-slate-700 text-sm font-semibold"
            >
              リセット
            </button>

            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => setView("internal")}
                className={`px-3 py-1 rounded-lg border text-xs ${
                  view === "internal"
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-700 border-slate-300"
                }`}
              >
                講師用
              </button>
              <button
                type="button"
                onClick={() => setView("parent")}
                className={`px-3 py-1 rounded-lg border text-xs ${
                  view === "parent"
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-700 border-slate-300"
                }`}
              >
                保護者用
              </button>
            </div>
          </div>

          {/* 結果 */}
          {(resultInternal || resultParent) && (
            <div className="border border-slate-200 rounded-xl p-3 bg-slate-50 whitespace-pre-wrap text-sm text-slate-800">
              {view === "internal" ? resultInternal : resultParent}
            </div>
          )}
        </form>
      </div>
    </main>
  );
}
