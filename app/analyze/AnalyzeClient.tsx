"use client";

import { useState } from "react";

type TeacherMode = "gentle" | "strict" | "data";

export default function AnalyzeClient() {
  /** ファイル状態 */
  const [singleFiles, setSingleFiles] = useState<File[]>([]);
  const [yearlyFile, setYearlyFile] = useState<File | null>(null);

  /** 講師モード */
  const [teacherMode, setTeacherMode] = useState<TeacherMode>("gentle");

  /** 通信状態 */
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);

  async function onAnalyze() {
    try {
      setLoading(true);
      setError(null);
      setResult(null);

      const fd = new FormData();
      singleFiles.forEach((f) => fd.append("single", f));
      if (yearlyFile) fd.append("yearly", yearlyFile);
      fd.append("teacherMode", teacherMode);

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

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 24 }}>
      {/* =========================
          分析モード ヘッダー
      ========================= */}
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>分析モード</h1>
      <p style={{ color: "#555", marginBottom: 24 }}>
        成績PDFをアップロードすると、AIが内容を読み取り、分析の土台を作成します。
        <br />
        ※スキャン画像PDFにも対応しています。
      </p>

      {/* =========================
          ① 成績データのアップロード
      ========================= */}
      <section style={sectionStyle}>
        <h2 style={sectionTitle}>① 成績データのアップロード</h2>

        {/* 単発テスト */}
        <div style={boxStyle}>
          <h3>今回のテスト（単発・複数可）</h3>
          <p style={hint}>
            公開模試・育成テストなど。複数枚アップロードできます。
          </p>
          <input
            type="file"
            accept="application/pdf"
            multiple
            onChange={(e) =>
              setSingleFiles(Array.from(e.target.files ?? []))
            }
          />
          {singleFiles.length > 0 && (
            <p style={fileInfo}>選択中：{singleFiles.length} 件</p>
          )}
        </div>

        {/* 年間成績 */}
        <div style={boxStyle}>
          <h3>年間成績表（1枚）</h3>
          <p style={hint}>
            1年分の成績がまとまったPDF（あれば）
          </p>
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) =>
              setYearlyFile(e.target.files?.[0] ?? null)
            }
          />
          {yearlyFile && (
            <p style={fileInfo}>選択中：{yearlyFile.name}</p>
          )}
        </div>
      </section>

      {/* =========================
          ② 講師の視点・トーン
      ========================= */}
      <section style={sectionStyle}>
        <h2 style={sectionTitle}>② 講師の視点</h2>

        <label>
          <input
            type="radio"
            name="teacher"
            checked={teacherMode === "gentle"}
            onChange={() => setTeacherMode("gentle")}
          />
          やさしく寄り添う
        </label>
        <br />
        <label>
          <input
            type="radio"
            name="teacher"
            checked={teacherMode === "strict"}
            onChange={() => setTeacherMode("strict")}
          />
          厳しめに課題を指摘
        </label>
        <br />
        <label>
          <input
            type="radio"
            name="teacher"
            checked={teacherMode === "data"}
            onChange={() => setTeacherMode("data")}
          />
          データ重視（保護者向け）
        </label>
      </section>

      {/* =========================
          実行ボタン
      ========================= */}
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

      {/* =========================
          結果表示
      ========================= */}
      {result && (
        <section style={{ marginTop: 40 }}>
          <h2>結果</h2>
          <p>{result.summary}</p>

          {result.ocr?.note && <p>{result.ocr.note}</p>}

          {/* 単発OCR */}
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

          {/* 年間OCR */}
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
   style
========================= */
const sectionStyle: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 8,
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
  padding: "10px 24px",
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
