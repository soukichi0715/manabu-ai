"use client";

import { useState } from "react";

export default function AnalyzeClient() {
  const [singleFiles, setSingleFiles] = useState<File[]>([]);
  const [yearlyFile, setYearlyFile] = useState<File | null>(null);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onAnalyze() {
    try {
      setLoading(true);
      setError(null);

      const fd = new FormData();
      singleFiles.forEach((f) => fd.append("single", f));
      if (yearlyFile) fd.append("yearly", yearlyFile);

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
    <div style={{ padding: 24 }}>
      <h2>分析モード</h2>

      <section>
        <h3>単発テスト（複数可）</h3>
        <input
          type="file"
          accept="application/pdf"
          multiple
          onChange={(e) => setSingleFiles(Array.from(e.target.files ?? []))}
        />
      </section>

      <section style={{ marginTop: 16 }}>
        <h3>年間成績表（1枚）</h3>
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setYearlyFile(e.target.files?.[0] ?? null)}
        />
      </section>

      <button
        style={{ marginTop: 24, padding: "8px 16px" }}
        onClick={onAnalyze}
        disabled={loading}
      >
        {loading ? "分析中…" : "この設定で分析する"}
      </button>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {result && (
        <section style={{ marginTop: 32 }}>
          <h3>結果</h3>
          <p>{result.summary}</p>

          {result.ocr?.note && <p>{result.ocr.note}</p>}

          <h4>単発OCR結果</h4>
          {result.ocr?.singles?.map((r: any, i: number) => (
            <div key={i} style={{ marginBottom: 16 }}>
              <b>{r.ok ? "✅" : "❌"} {r.name}</b>
              {r.ok ? (
                <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: 12 }}>
                  {r.text}
                </pre>
              ) : (
                <div style={{ color: "crimson" }}>{r.error}</div>
              )}
            </div>
          ))}

          {result.ocr?.yearly && (
            <>
              <h4>年間OCR結果</h4>
              <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: 12 }}>
                {result.ocr.yearly}
              </pre>
            </>
          )}
        </section>
      )}
    </div>
  );
}
