"use client";

import { useMemo, useRef, useState } from "react";

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
  /** hidden input refs（ボタンで発火） */
  const singleInputRef = useRef<HTMLInputElement | null>(null);
  const yearlyInputRef = useRef<HTMLInputElement | null>(null);

  /** ファイル */
  const [singleFiles, setSingleFiles] = useState<File[]>([]);
  const [yearlyFile, setYearlyFile] = useState<File | null>(null);

  /** 講師設定（UI → API 連携） */
  const [tone, setTone] = useState<TeacherTone>("gentle");
  const [focus, setFocus] = useState<FocusAxis[]>(["mistake"]);
  const [target, setTarget] = useState<OutputTarget>("student"); // ★1つのみ

  /** 通信状態 */
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);

  /** checkbox 切替 */
  function toggle<T>(arr: T[], value: T, setter: (v: T[]) => void) {
    setter(arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]);
  }

  /** UI表示用：ファイル名一覧 */
  const singleFileNames = useMemo(() => singleFiles.map((f) => f.name), [singleFiles]);

  /* =========================
     File handlers
  ========================= */
  function onPickSingles() {
    singleInputRef.current?.click();
  }

  function onPickYearly() {
    yearlyInputRef.current?.click();
  }

  function onSinglesSelected(files: FileList | null) {
    const picked = Array.from(files ?? []);
    if (picked.length === 0) return;

    setSingleFiles((prev) => [...prev, ...picked]);

    if (singleInputRef.current) singleInputRef.current.value = "";
  }

  function onYearlySelected(files: FileList | null) {
    const picked = files?.[0] ?? null;
    setYearlyFile(picked);

    if (yearlyInputRef.current) yearlyInputRef.current.value = "";
  }

  function clearSingles() {
    setSingleFiles([]);
  }

  function removeSingleAt(idx: number) {
    setSingleFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  function clearYearly() {
    setYearlyFile(null);
  }

  /* =========================
     分析実行（API連携）
  ========================= */
  async function onAnalyze() {
    try {
      setLoading(true);
      setError(null);
      setResult(null);

      const fd = new FormData();

      // 単発：複数
      singleFiles.forEach((f) => fd.append("single", f));

      // 年間：1枚
      if (yearlyFile) fd.append("yearly", yearlyFile);

      // UI → API 連携
      fd.append("tone", tone);
      fd.append("focus", JSON.stringify(focus));
      fd.append("target", target); // ★1つのみ

      const res = await fetch("/api/analyze", {
        method: "POST",
        body: fd,
      });

      if (!res.ok) throw new Error(await res.text());
      setResult(await res.json());
    } catch (e: any) {
      setError(e?.message ?? "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }

  const canRun = singleFiles.length > 0 || !!yearlyFile;

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

      {/* hidden inputs */}
      <input
        ref={singleInputRef}
        type="file"
        accept="application/pdf"
        multiple
        style={{ display: "none" }}
        onChange={(e) => onSinglesSelected(e.target.files)}
      />
      <input
        ref={yearlyInputRef}
        type="file"
        accept="application/pdf"
        style={{ display: "none" }}
        onChange={(e) => onYearlySelected(e.target.files)}
      />

      {/* ---------- ① Upload ---------- */}
      <section style={sectionStyle}>
        <h2 style={sectionTitle}>① 成績データのアップロード</h2>

        {/* 単発（複数） */}
        <div style={boxStyle}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
            <div>
              <h3 style={{ margin: 0 }}>今回のテスト（単発・複数可）</h3>
              <p style={hint}>公開模試・育成テストなど（複数枚OK）</p>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" style={pickButton} onClick={onPickSingles}>
                単発PDFを選択
              </button>
              <button
                type="button"
                style={{ ...subButton, opacity: singleFiles.length ? 1 : 0.5 }}
                onClick={clearSingles}
                disabled={singleFiles.length === 0}
              >
                クリア
              </button>
            </div>
          </div>

          {singleFiles.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <p style={fileInfo}>選択中：{singleFiles.length} 件</p>

              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {singleFileNames.map((name, i) => (
                  <li key={`${name}-${i}`} style={{ marginBottom: 6 }}>
                    <span>{name}</span>
                    <button
                      type="button"
                      style={{ ...linkButton, marginLeft: 10 }}
                      onClick={() => removeSingleAt(i)}
                      disabled={loading}
                      title="この1件だけ外す"
                    >
                      削除
                    </button>
                  </li>
                ))}
              </ul>

              <p style={{ ...hint, marginTop: 10 }}>
                ※ 追加したい場合は、もう一度「単発PDFを選択」を押してください（追加入力）。
              </p>
            </div>
          ) : (
            <p style={hint}>未選択</p>
          )}
        </div>

        {/* 年間（1枚） */}
        <div style={boxStyle}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
            <div>
              <h3 style={{ margin: 0 }}>年間成績表（1枚）</h3>
              <p style={hint}>1年分の成績推移が分かるPDF（任意）</p>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" style={pickButton} onClick={onPickYearly}>
                年間PDFを選択
              </button>
              <button
                type="button"
                style={{ ...subButton, opacity: yearlyFile ? 1 : 0.5 }}
                onClick={clearYearly}
                disabled={!yearlyFile}
              >
                クリア
              </button>
            </div>
          </div>

          {yearlyFile ? <p style={fileInfo}>選択中：{yearlyFile.name}</p> : <p style={hint}>未選択</p>}
        </div>
      </section>

      {/* ---------- ② Teacher Settings ---------- */}
      <section style={sectionStyle}>
        <h2 style={sectionTitle}>② 講師の視点・分析方針</h2>

        {/* トーン */}
        <div style={boxStyle}>
          <h3>指導トーン</h3>
          <label>
            <input type="radio" name="tone" checked={tone === "gentle"} onChange={() => setTone("gentle")} />
            やさしく寄り添う
          </label>
          <br />
          <label>
            <input type="radio" name="tone" checked={tone === "balanced"} onChange={() => setTone("balanced")} />
            バランス型（標準）
          </label>
          <br />
          <label>
            <input type="radio" name="tone" checked={tone === "strict"} onChange={() => setTone("strict")} />
            厳しめに課題を明確化
          </label>
        </div>

        {/* 視点（複数） */}
        <div style={boxStyle}>
          <h3>分析の軸（複数選択可）</h3>
          <label>
            <input
              type="checkbox"
              checked={focus.includes("mistake")}
              onChange={() => toggle(focus, "mistake", setFocus)}
            />
            ミスの種類・傾向
          </label>
          <br />
          <label>
            <input
              type="checkbox"
              checked={focus.includes("process")}
              onChange={() => toggle(focus, "process", setFocus)}
            />
            解き方・思考プロセス
          </label>
          <br />
          <label>
            <input
              type="checkbox"
              checked={focus.includes("knowledge")}
              onChange={() => toggle(focus, "knowledge", setFocus)}
            />
            知識・単元理解
          </label>
          <br />
          <label>
            <input
              type="checkbox"
              checked={focus.includes("attitude")}
              onChange={() => toggle(focus, "attitude", setFocus)}
            />
            学習姿勢・取り組み方
          </label>

          <p style={{ ...hint, marginTop: 10 }}>
            ※ APIには <code>focus</code> をJSON配列で送ります（例：["mistake","process"]）。
          </p>
        </div>

        {/* 出力対象（1つのみ） */}
        <div style={boxStyle}>
          <h3>出力対象（1つ選択）</h3>

          <label>
            <input type="radio" name="target" checked={target === "student"} onChange={() => setTarget("student")} />
            生徒向け
          </label>
          <br />
          <label>
            <input type="radio" name="target" checked={target === "parent"} onChange={() => setTarget("parent")} />
            保護者向け
          </label>
          <br />
          <label>
            <input type="radio" name="target" checked={target === "teacher"} onChange={() => setTarget("teacher")} />
            講師用（指導メモ）
          </label>
        </div>
      </section>

      {/* ---------- Execute ---------- */}
      <div style={{ textAlign: "center", marginTop: 32 }}>
        <button
          onClick={onAnalyze}
          disabled={loading || !canRun}
          style={{
            ...analyzeButton,
            opacity: loading || !canRun ? 0.6 : 1,
            cursor: loading || !canRun ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "分析中…" : "この設定で分析する"}
        </button>

        {!canRun && <p style={{ ...hint, marginTop: 10 }}>単発PDFまたは年間PDFを選択してください。</p>}
        {error && <p style={{ color: "crimson", marginTop: 12 }}>{error}</p>}
      </div>

      {/* ---------- Result ---------- */}
      {result && (
        <section style={{ marginTop: 40 }}>
          <h2>結果</h2>
          <p>{result.summary}</p>

          {result.ocr?.note && <p>{result.ocr.note}</p>}

          {/* ★追加：年間 成績表判定 */}
          {result.ocr?.yearlyGradeCheck && (
            <div style={{ marginTop: 12 }}>
              <h3>年間PDF：成績表判定</h3>
              <p>
                判定：<b>{result.ocr.yearlyGradeCheck.isGradeReport ? "成績表っぽい ✅" : "成績表ではなさそう ❌"}</b>{" "}
                （信頼度 {result.ocr.yearlyGradeCheck.confidence}）
              </p>
              <p style={hint}>理由：{result.ocr.yearlyGradeCheck.reason}</p>
            </div>
          )}

          {result.ocr?.singles && (
            <>
              <h3 style={{ marginTop: 20 }}>単発テスト OCR結果</h3>

              {result.ocr.singles.map((r: any, i: number) => (
                <div key={i} style={{ marginBottom: 20 }}>
                  <b>
                    {r.ok ? "✅" : "❌"} {r.name}
                  </b>

                  {/* ★追加：単発 成績表判定 */}
                  {r.gradeCheck && (
                    <div style={{ marginTop: 6 }}>
                      判定：{" "}
                      <b>{r.gradeCheck.isGradeReport ? "成績表っぽい ✅" : "成績表ではなさそう ❌"}</b>{" "}
                      （信頼度 {r.gradeCheck.confidence}）
                      <div style={hint}>理由：{r.gradeCheck.reason}</div>
                    </div>
                  )}

                  {r.ok ? <pre style={preStyle}>{r.text}</pre> : <div style={{ color: "crimson" }}>{r.error}</div>}
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

          {result.selections && (
            <>
              <h3>（デバッグ）選択設定</h3>
              <pre style={preStyle}>{JSON.stringify(result.selections, null, 2)}</pre>
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
};

const pickButton: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #bbb",
  background: "#fff",
  cursor: "pointer",
};

const subButton: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #ddd",
  background: "#f7f7f7",
  cursor: "pointer",
};

const linkButton: React.CSSProperties = {
  padding: 0,
  border: "none",
  background: "transparent",
  color: "#2563eb",
  cursor: "pointer",
  textDecoration: "underline",
  fontSize: 12,
};

const preStyle: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  background: "#f7f7f7",
  padding: 12,
  borderRadius: 8,
  marginTop: 10,
};

const hint: React.CSSProperties = {
  fontSize: 13,
  color: "#666",
};

const fileInfo: React.CSSProperties = {
  fontSize: 12,
  color: "#333",
  marginTop: 6,
};
