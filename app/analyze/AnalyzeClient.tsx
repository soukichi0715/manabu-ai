"use client";

import { useState } from "react";

/* =========================
   型定義
========================= */
type TeacherTone = "gentle" | "balanced" | "strict";
type FocusAxis = "mistake" | "process" | "knowledge" | "attitude";
type OutputTarget = "student" | "parent" | "teacher";

/* =========================
   Component
========================= */
export default function AnalyzeClient() {
  /** ファイル */
  const [singleFiles, setSingleFiles] = useState<File[]>([]);
  const [yearlyFile, setYearlyFile] = useState<File | null>(null);

  /** 講師設定（UI → API 連携） */
  const [tone, setTone] = useState<TeacherTone>("gentle");
  const [focus, setFocus] = useState<FocusAxis[]>(["mistake"]);
  const [targets, setTargets] = useState<OutputTarget[]>(["student"]);

  /** 通信状態 */
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);

  /** checkbox 切替 */
  function toggle<T>(arr: T[], value: T, setter: (v: T[]) => void) {
    setter(arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value]);
  }

  /* =========================
     分析実行
  ========================= */
  async function onAnalyze() {
    try {
      setLoading(true);
      setError(null);
      setResult(null);

      const fd = new FormData();
      singleFiles.forEach(f => fd.append("single", f));
      if (yearlyFile) fd.append("yearly", yearlyFile);

      // UI → API 連携
      fd.append("tone", tone);
      fd.append("focus", JSON.stringify(focus));
      fd.append("targets", JSON.stringify(targets));

      const res = await fetch("/api/analyze", {
        method: "POST",
        body: fd,
      });

      if (!res.ok) throw new Error(await res.text());
      setResult(await res.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  /* =========================
     UI
  ========================= */
  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}>
      {/* ---------- Header ---------- */}
      <h1 style={{ fontSize: 26, marginBottom: 8 }}>分析モード</h1>
      <p style={{ color: "#555", marginBottom: 28 }}>
        成績PDFをアップロードすると、AIが内容を読み取り、分析の土台を作成します。
        <br />
        ※ スキャン画像PDFにも対応しています。
      </p>

      {/* ---------- ① Upload ---------- */}
      <section style={sectionStyle}>
        <h2 style={sectionTitle}>① 成績データのアップロード</h2>

        <div style={boxStyle}>
          <h3>今回のテスト（単発・複数可）</h3>
          <p style={hint}>公開模試・育成テストなど（複数枚OK）</p>
          <input
            type="file"
            accept="application/pdf"
            multiple
            onChange={e => setSingleFiles(Array.from(e.target.files ?? []))}
          />
          {singleFiles.length > 0 && (
            <p style={fileInfo}>選択中：{singleFiles.length} 件</p>
          )}
        </div>

        <div style={boxStyle}>
          <h3>年間成績表（1枚）</h3>
          <p style={hint}>1年分の成績推移が分かるPDF（任意）</p>
          <input
            type="file"
            accept="application/pdf"
            onChange={e => setYearlyFile(e.target.files?.[0] ?? null)}
          />
          {yearlyFile && (
            <p style={fileInfo}>選択中：{yearlyFile.name}</p>
          )}
        </div>
      </section>

      {/* ---------- ② Teacher Settings ---------- */}
      <section style={sectionStyle}>
        <h2 style={sectionTitle}>② 講師の視点・分析方針</h2>

        <div style={boxStyle}>
          <h3>指導トーン</h3>
          <label>
            <input
              type="radio"
              checked={tone === "gentle"}
              onChange={() => setTone("gentle")}
            />
            やさしく寄り添う
          </label><br />
          <label>
            <input
              type="radio"
              checked={tone === "balanced"}
              onChange={() => setTone("balanced")}
            />
            バランス型（標準）
          </label><br />
          <label>
            <input
              type="radio"
              checked={tone === "strict"}
              onChange={() => setTone("strict")}
            />
            厳しめに課題を明確化
          </label>
        </div>

        <div style={boxStyle}>
          <h3>分析の軸（複数選択可）</h3>
          <label>
            <input
              type="checkbox"
              checked={focus.includes("mistake")}
              onChange={() => toggle(focus, "mistake", setFocus)}
            />
            ミスの種類・傾向
          </label><br />
          <label>
            <input
              type="checkbox"
              checked={focus.includes("process")}
              onChange={() => toggle(focus, "process", setFocus)}
            />
            解き方・思考プロセス
          </label><br />
          <label>
            <input
              type="checkbox"
              checked={focus.includes("knowledge")}
              onChange={() => toggle(focus, "knowledge", setFocus)}
            />
            知識・単元理解
          </label><br />
          <label>
            <input
              type="checkbox"
              checked={focus.includes("attitude")}
              onChange={() => toggle(focus, "attitude", setFocus)}
            />
            学習姿勢・取り組み方
          </label>
        </div>

        <div style={boxStyle}>
          <h3>出力対象</h3>
          <label>
            <input
              type="checkbox"
              checked={targets.includes("student")}
              onChange={() => toggle(targets, "student", setTargets)}
            />
            生徒向け
          </label><br />
          <label>
            <input
              type="checkbox"
              checked={targets.includes("parent")}
              onChange={() => toggle(targets, "parent", setTargets)}
            />
            保護者向け
          </label><br />
          <label>
            <input
              type="checkbox"
              checked={targets.includes("teacher")}
              onChange={() => toggle(targets, "teacher", setTargets)}
            />
            講師用（指導メモ）
          </label>
        </div>
      </section>

      {/* ---------- Execute ---------- */}
      <div style={{ textAlign: "center", marginTop: 32 }}>
        <button
          onClick={onAnalyze}
          disabled={loading}
          style={analyzeButton}
        >
          {loading ? "分析中…" : "この設定で分析する"}
        </button>
        {error && <p style={{ color: "crimson" }}>{error}</p>}
      </div>

      {/* ---------- Result ---------- */}
      {result && (
        <section style={{ marginTop: 40 }}>
          <h2>結果</h2>
          <p>{result.summary}</p>

          {result.ocr?.note && <p>{result.ocr.note}</p>}

          {result.ocr?.singles && (
            <>
              <h3>単発テスト OCR結果</h3>
              {result.ocr.singles.map((r: any, i: number) => (
                <div key={i} style={{ marginBottom: 20 }}>
                  <b>{r.ok ? "✅" : "❌"} {r.name}</b>
                  {r.ok ? (
                    <pre style={preStyle}>{r.text}</pre>
                  ) : (
                    <div style={{ color: "crimson" }}>{r.error}</div>
                  )}
                </div>
              ))}
            </>
          )}

          {result.ocr?.yearly && (
            <>
              <h3>年間成績 OCR結果</h3>
              <pre style={preStyle}>{result.ocr.yearly}</pre>
            </>
          )}
        </section>
      )}
    </div>
  );
}

/* =========================
   styles
========================= */
const sectionStyle: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 10,
  padding: 16,
  marginBottom: 24,
};

const sectionTitle: React.CSSProperties = {
  fontSize: 18,
  marginBottom: 12,
};

const boxStyle: React.CSSProperties = {
  border: "1px dashed #ccc",
  borderRadius: 8,
  padding: 12,
  marginBottom: 16,
};

const analyzeButton: React.CSSProperties = {
  fontSize: 16,
  padding: "12px 28px",
  borderRadius: 8,
  background: "#2563eb",
  color: "#fff",
  border: "none",
  cursor: "pointer",
};

const preStyle: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  background: "#f7f7f7",
  padding: 12,
  borderRadius: 8,
};

const hint: React.CSSProperties = {
  fontSize: 13,
  color: "#666",
};

const fileInfo: React.CSSProperties = {
  fontSize: 12,
  color: "#333",
  marginTop: 4,
};
