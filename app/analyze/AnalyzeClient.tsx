"use client";

import React, { useMemo, useState } from "react";

type Tone = "strict" | "balance" | "encourage";
type Focus = "self" | "method" | "environment";
type Term = "short" | "mid" | "long";
type Intervention = "min" | "std" | "deep";

type UploadedFile = { path: string; name: string; size: number; signedUrl?: string | null };

type AnalyzeResult = {
  summary: string;
  nextActions: string[];
  files: {
    single: UploadedFile | null;
    yearly: UploadedFile[];
  };
  selections: {
    tone: Tone | string;
    focus: Focus | string;
    term: Term | string;
    missTypes: string[];
    intervention: Intervention | string;
    targets: string[];
  };
  extractedText?: string | null;
};

export default function AnalyzeClient() {
  const [singlePdf, setSinglePdf] = useState<File | null>(null);
  const [yearlyPdfs, setYearlyPdfs] = useState<File[]>([]);

  const [tone, setTone] = useState<Tone>("balance");
  const [focus, setFocus] = useState<Focus>("method");
  const [term, setTerm] = useState<Term>("mid");
  const [missTypes, setMissTypes] = useState<string[]>([]);
  const [intervention, setIntervention] = useState<Intervention>("std");
  const [targets, setTargets] = useState<string[]>(["coach", "parent"]);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResult | null>(null);

  const canRun = useMemo(() => {
    return !!singlePdf || yearlyPdfs.length > 0;
  }, [singlePdf, yearlyPdfs]);

  function toggleArray(current: string[], value: string, setter: (v: string[]) => void) {
    if (current.includes(value)) setter(current.filter((x) => x !== value));
    else setter([...current, value]);
  }

  async function runAnalyze() {
    if (!canRun) {
      setErr("PDFを選択してください（単発または年間）。");
      return;
    }

    setLoading(true);
    setErr(null);
    setResult(null);

    try {
      const fd = new FormData();
      if (singlePdf) fd.append("single", singlePdf);
      yearlyPdfs.forEach((f) => fd.append("yearly", f));

      fd.append("tone", tone);
      fd.append("focus", focus);
      fd.append("term", term);
      fd.append("missTypes", JSON.stringify(missTypes));
      fd.append("intervention", intervention);
      fd.append("targets", JSON.stringify(targets));

      const r = await fetch("/api/analyze", { method: "POST", body: fd });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || `HTTP ${r.status}`);
      }

      const data = (await r.json()) as AnalyzeResult;
      setResult(data);
    } catch (e: any) {
      setErr(e?.message ?? "分析に失敗しました。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 1000, margin: "40px auto", padding: "0 16px" }}>
      <header style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 26, marginBottom: 8 }}>分析モード</h1>
        <p style={{ color: "#555" }}>
          成績データと講師の視点をもとに、課題と次の打ち手を整理します。
        </p>
      </header>

      {/* ① アップロード */}
      <section style={sectionStyle}>
        <h2 style={sectionTitle}>① 成績データのアップロード</h2>

        <div style={boxStyle}>
          <h3 style={boxTitle}>今回のテスト（単発分析）</h3>
          <p style={boxDesc}>育成テスト・公開模試など、1回分の成績表PDF</p>

          <input
            id="singleTestPdf"
            type="file"
            accept="application/pdf"
            style={{ display: "none" }}
            onChange={(e) => setSinglePdf(e.target.files?.[0] ?? null)}
          />
          <label htmlFor="singleTestPdf" style={buttonStyle}>
            PDFを選択
          </label>

          <div style={{ marginTop: 8, color: "#444", fontSize: 13 }}>
            {singlePdf ? `選択中：${singlePdf.name}` : "未選択"}
          </div>
        </div>

        <div style={{ ...boxStyle, marginTop: 16 }}>
          <h3 style={boxTitle}>1年分の成績（推移分析）</h3>
          <p style={boxDesc}>過去1年分の成績表PDFをまとめてアップロード</p>

          <input
            id="yearlyPdf"
            type="file"
            accept="application/pdf"
            multiple
            style={{ display: "none" }}
            onChange={(e) => setYearlyPdfs(Array.from(e.target.files ?? []))}
          />
          <label htmlFor="yearlyPdf" style={buttonStyle}>
            PDFをまとめて選択
          </label>

          <div style={{ marginTop: 8, color: "#444", fontSize: 13 }}>
            {yearlyPdfs.length > 0 ? `選択中：${yearlyPdfs.length}件` : "未選択"}
          </div>
        </div>
      </section>

      {/* ② 講師の視点 */}
      <section style={sectionStyle}>
        <h2 style={sectionTitle}>② 講師の視点設定</h2>

        <fieldset style={fieldSetStyle}>
          <legend style={legendStyle}>分析スタンス（トーン）</legend>
          <label>
            <input type="radio" name="tone" checked={tone === "strict"} onChange={() => setTone("strict")} /> 厳しめ
          </label>
          <br />
          <label>
            <input type="radio" name="tone" checked={tone === "balance"} onChange={() => setTone("balance")} /> バランス
          </label>
          <br />
          <label>
            <input type="radio" name="tone" checked={tone === "encourage"} onChange={() => setTone("encourage")} /> 励まし重視
          </label>
        </fieldset>

        <fieldset style={fieldSetStyle}>
          <legend style={legendStyle}>指導視点（原因の置き所）</legend>
          <label>
            <input type="radio" name="focus" checked={focus === "self"} onChange={() => setFocus("self")} /> 本人要因
          </label>
          <br />
          <label>
            <input type="radio" name="focus" checked={focus === "method"} onChange={() => setFocus("method")} /> 学習方法
          </label>
          <br />
          <label>
            <input type="radio" name="focus" checked={focus === "environment"} onChange={() => setFocus("environment")} /> 環境要因
          </label>
        </fieldset>

        <fieldset style={fieldSetStyle}>
          <legend style={legendStyle}>合格戦略（時間軸）</legend>
          <label>
            <input type="radio" name="term" checked={term === "short"} onChange={() => setTerm("short")} /> 短期（次回テスト）
          </label>
          <br />
          <label>
            <input type="radio" name="term" checked={term === "mid"} onChange={() => setTerm("mid")} /> 中期（学期・講習）
          </label>
          <br />
          <label>
            <input type="radio" name="term" checked={term === "long"} onChange={() => setTerm("long")} /> 長期（入試逆算）
          </label>
        </fieldset>

        <fieldset style={fieldSetStyle}>
          <legend style={legendStyle}>ミス傾向（複数選択）</legend>
          {["計算ミス", "条件整理ミス", "読み違い", "立式ミス", "時間配分ミス", "ケアレス混在"].map((m) => (
            <React.Fragment key={m}>
              <label>
                <input
                  type="checkbox"
                  checked={missTypes.includes(m)}
                  onChange={() => toggleArray(missTypes, m, setMissTypes)}
                />{" "}
                {m}
              </label>
              <br />
            </React.Fragment>
          ))}
        </fieldset>

        <fieldset style={fieldSetStyle}>
          <legend style={legendStyle}>介入レベル</legend>
          <label>
            <input type="radio" name="intervention" checked={intervention === "min"} onChange={() => setIntervention("min")} /> 最小
          </label>
          <br />
          <label>
            <input type="radio" name="intervention" checked={intervention === "std"} onChange={() => setIntervention("std")} /> 標準
          </label>
          <br />
          <label>
            <input type="radio" name="intervention" checked={intervention === "deep"} onChange={() => setIntervention("deep")} /> 徹底
          </label>
        </fieldset>

        <fieldset style={fieldSetStyle}>
          <legend style={legendStyle}>出力対象</legend>
          {[
            { key: "coach", label: "講師用" },
            { key: "parent", label: "保護者用" },
            { key: "student", label: "生徒用" },
            { key: "meeting", label: "面談用まとめ" },
          ].map((t) => (
            <React.Fragment key={t.key}>
              <label>
                <input
                  type="checkbox"
                  checked={targets.includes(t.key)}
                  onChange={() => toggleArray(targets, t.key, setTargets)}
                />{" "}
                {t.label}
              </label>
              <br />
            </React.Fragment>
          ))}
        </fieldset>
      </section>

      {/* ③ 実行 */}
      <section style={{ marginTop: 32, textAlign: "center" }}>
        <button
          onClick={runAnalyze}
          disabled={!canRun || loading}
          style={{
            padding: "14px 28px",
            fontSize: 16,
            background: !canRun || loading ? "#93c5fd" : "#2563eb",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            cursor: !canRun || loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "分析中..." : "この設定で分析する"}
        </button>

        {err && <div style={{ marginTop: 12, color: "#b91c1c" }}>{err}</div>}
      </section>

      {/* 結果 */}
      {result && (
        <section style={{ ...sectionStyle, marginTop: 32 }}>
          <h2 style={sectionTitle}>結果</h2>
          <p style={{ whiteSpace: "pre-wrap" }}>{result.summary}</p>

          <h3 style={{ marginTop: 16, fontSize: 16 }}>次の打ち手</h3>
          <ul>
            {(result.nextActions ?? []).map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>

          <h3 style={{ marginTop: 16, fontSize: 16 }}>アップロード</h3>
          <div style={{ fontSize: 13, color: "#444" }}>
            単発：
            {result.files.single
              ? ` ${result.files.single.name}（${result.files.single.path}）`
              : " なし"}
            {result.files.single?.signedUrl ? (
              <>
                {" "}
                /{" "}
                <a href={result.files.single.signedUrl} target="_blank" rel="noreferrer">
                  署名URLで開く（10分）
                </a>
              </>
            ) : null}
            <br />
            年間：{result.files.yearly.length}件
          </div>

          {result.extractedText && (
            <>
              <h3 style={{ marginTop: 16, fontSize: 16 }}>OCR抽出テキスト</h3>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  background: "#f7f7f7",
                  padding: 12,
                  borderRadius: 8,
                  border: "1px solid #ddd",
                }}
              >
                {result.extractedText}
              </pre>
            </>
          )}
        </section>
      )}
    </div>
  );
}

/* styles */
const sectionStyle: React.CSSProperties = {
  marginTop: 32,
  padding: 20,
  border: "1px solid #ddd",
  borderRadius: 12,
};
const sectionTitle: React.CSSProperties = { fontSize: 18, marginBottom: 16 };
const boxStyle: React.CSSProperties = {
  padding: 16,
  border: "1px solid #ccc",
  borderRadius: 10,
  background: "#fafafa",
};
const boxTitle: React.CSSProperties = { fontSize: 15, marginBottom: 4 };
const boxDesc: React.CSSProperties = { fontSize: 13, color: "#666", marginBottom: 8 };
const fieldSetStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 12,
  border: "1px solid #ccc",
  borderRadius: 8,
};
const legendStyle: React.CSSProperties = { fontWeight: "bold", fontSize: 14 };
const buttonStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "10px 16px",
  background: "#e5e7eb",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
};
