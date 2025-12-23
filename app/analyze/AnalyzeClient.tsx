"use client";

import React, { useMemo, useState } from "react";
import ReportTabs from "@/components/ReportTabs";

type Tone = "gentle" | "balanced" | "strict";
type Target = "student" | "parent" | "teacher";
type FocusAxis = "mistake" | "process" | "knowledge" | "attitude";

type GradeCheck = {
  isGradeReport: boolean;
  confidence: number;
  reason: string;
};

type ReportJson = {
  docType: "report";
  student: { name: string | null; id: string | null };
  test: { name: string | null; date: string | null };
  overall: { score: number | null; deviation: number | null; rank: number | null; avg: number | null };
  subjects: { name: string; score: number | null; deviation: number | null; avg: number | null; rank: number | null }[];
  notes: string[];
};

type OcrSingleResult =
  | {
      ok: true;
      path: string;
      name: string;
      size: number;
      text: string;
      gradeCheck: GradeCheck;
      reportJson: ReportJson | null;
      reportJsonMeta: { ok: boolean; error: string | null } | null;
    }
  | {
      ok: false;
      path: string;
      name: string;
      size: number;
      error: string;
      gradeCheck?: GradeCheck;
    };

type AnalyzeResponse = {
  summary: string;

  // ✅ 追加：APIが返す追加フィールド（既存を壊さないため optional）
  analysisMode?: "full" | "yearly-only";
  studentType?: "two" | "four";
  isTwoSubjectStudent?: boolean;
  warnings?: string[];
  reports?: {
    menndan_1min: { title: string; body: string; bullets?: string[]; tags?: string[] };
    child_simple: { title: string; body: string; action?: string };
    parent_handout: { title: string; summary: string; points: string[]; nextAction: string };
  };
  mistakeSummary?: any;
  yearlyTrends?: any;
  commentary?: string;

  files: {
    singles: { path: string; name: string; size: number }[];
    yearly: { path: string; name: string; size: number } | null;
  };
  ocr: {
    singles: OcrSingleResult[];
    yearly: string | null;

    // ✅ 互換のため optional（新旧の違い吸収）
    yearlyError?: string | null;
    yearlyGradeCheck?: GradeCheck | null;

    yearlyReportJson: ReportJson | null;
    yearlyReportJsonMeta: { ok: boolean; error: string | null } | null;

    note: string | null;

    // ✅ 互換：route側が yearlyDebug / yearlyReportJsonMeta など返す場合の吸収
    yearlyDebug?: any;
    yearlyReportJsonMeta2?: any;
  };
  selections: {
    tone: Tone;
    focus: FocusAxis[];
    target: Target;
  };
  analysis?: {
    singles: {
      subjects: {
        name: string;
        count: number;
        avgDeviation: number | null;
        lastDeviation: number | null;
        minDeviation: number | null;
      }[];
      weakest: {
        name: string;
        count: number;
        avgDeviation: number | null;
        lastDeviation: number | null;
        minDeviation: number | null;
      } | null;
    };
    yearly: {
      subjects: {
        name: string;
        deviation: number | null;
        score: number | null;
        avg: number | null;
        rank: number | null;
      }[];
      weakest: {
        name: string;
        deviation: number | null;
        score: number | null;
        avg: number | null;
        rank: number | null;
      } | null;
    };
  };
};

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes)) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function AnalyzeClient() {
  const [singleFiles, setSingleFiles] = useState<FileList | null>(null);
  const [yearlyFile, setYearlyFile] = useState<File | null>(null);

  const [tone, setTone] = useState<Tone>("gentle");
  const [target, setTarget] = useState<Target>("student");
  const [focus, setFocus] = useState<FocusAxis[]>(["mistake"]);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);

  const singleCount = singleFiles?.length ?? 0;

  const focusOptions: { key: FocusAxis; label: string; desc: string }[] = useMemo(
    () => [
      { key: "mistake", label: "ミス分析", desc: "取りこぼし・ケアレスミス・傾向" },
      { key: "process", label: "思考プロセス", desc: "考え方の順序・図や式の使い方" },
      { key: "knowledge", label: "知識/定着", desc: "典型解法・基礎の穴・暗記事項" },
      { key: "attitude", label: "姿勢/習慣", desc: "時間配分・見直し・復習サイクル" },
    ],
    []
  );

  function toggleFocus(k: FocusAxis) {
    setFocus((prev) => {
      if (prev.includes(k)) return prev.filter((x) => x !== k);
      return [...prev, k];
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setResult(null);

    if (!singleFiles && !yearlyFile) {
      setErr("PDFを選択してください（単発か年間のどちらか）。");
      return;
    }

    setLoading(true);
    try {
      const fd = new FormData();

      // UI仕様：単発=複数（キー single を複数append）
      if (singleFiles) {
        Array.from(singleFiles).forEach((f) => fd.append("single", f));
      }

      // UI仕様：年間=1枚（キー yearly）
      if (yearlyFile) {
        fd.append("yearly", yearlyFile);
      }

      fd.append("tone", tone);
      fd.append("target", target);
      fd.append("focus", JSON.stringify(focus));

      const r = await fetch("/api/analyze", {
        method: "POST",
        body: fd,
      });

      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(t || `Server error (${r.status})`);
      }

      const data = (await r.json()) as AnalyzeResponse;
      setResult(data);
    } catch (e: any) {
      setErr(e?.message ?? "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 18 }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 12 }}>分析モード</h1>

      <form onSubmit={onSubmit}>
        {/* ① Upload */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {/* 単発テスト */}
          <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>① 今回のテスト（単発）</div>
            <div style={{ color: "#666", fontSize: 13, marginBottom: 10 }}>
              PDFを複数枚アップロードできます（例：表紙/成績/各科目など）
            </div>

            <input type="file" accept="application/pdf" multiple onChange={(e) => setSingleFiles(e.target.files)} />

            <div style={{ marginTop: 8, color: "#444", fontSize: 13 }}>選択：{singleCount ? `${singleCount} 件` : "なし"}</div>

            {singleFiles && singleCount > 0 && (
              <div style={{ marginTop: 8 }}>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {Array.from(singleFiles).map((f) => (
                    <li key={f.name} style={{ fontSize: 13, color: "#333" }}>
                      {f.name}（{formatBytes(f.size)}）
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* 年間成績 */}
          <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>② 1年分の成績（年間）</div>
            <div style={{ color: "#666", fontSize: 13, marginBottom: 10 }}>年間の成績表は1枚想定（推移・一覧）</div>

            <input type="file" accept="application/pdf" onChange={(e) => setYearlyFile(e.target.files?.[0] ?? null)} />

            <div style={{ marginTop: 8, color: "#444", fontSize: 13 }}>
              選択：{yearlyFile ? `${yearlyFile.name}（${formatBytes(yearlyFile.size)}）` : "なし"}
            </div>
          </div>
        </div>

        {/* ② Teacher selections */}
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14, marginTop: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 10 }}>③ 講師の視点（出力設定）</div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            {/* tone */}
            <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>トーン</div>
              <label style={{ display: "block", marginBottom: 6 }}>
                <input type="radio" name="tone" value="gentle" checked={tone === "gentle"} onChange={() => setTone("gentle")} />{" "}
                優しめ（共感多め）
              </label>
              <label style={{ display: "block", marginBottom: 6 }}>
                <input type="radio" name="tone" value="balanced" checked={tone === "balanced"} onChange={() => setTone("balanced")} />{" "}
                バランス（優しさ7：厳しさ3）
              </label>
              <label style={{ display: "block" }}>
                <input type="radio" name="tone" value="strict" checked={tone === "strict"} onChange={() => setTone("strict")} />{" "}
                厳しめ（改善点を明確に）
              </label>
            </div>

            {/* target */}
            <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>出力対象</div>
              <label style={{ display: "block", marginBottom: 6 }}>
                <input type="radio" name="target" value="student" checked={target === "student"} onChange={() => setTarget("student")} />{" "}
                子ども向け
              </label>
              <label style={{ display: "block", marginBottom: 6 }}>
                <input type="radio" name="target" value="parent" checked={target === "parent"} onChange={() => setTarget("parent")} />{" "}
                保護者向け
              </label>
              <label style={{ display: "block" }}>
                <input type="radio" name="target" value="teacher" checked={target === "teacher"} onChange={() => setTarget("teacher")} />{" "}
                講師/社内向け
              </label>
            </div>

            {/* focus */}
            <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>分析の観点</div>
              {focusOptions.map((o) => (
                <label key={o.key} style={{ display: "block", marginBottom: 8 }}>
                  <input type="checkbox" checked={focus.includes(o.key)} onChange={() => toggleFocus(o.key)} /> <b>{o.label}</b>
                  <div style={{ fontSize: 12, color: "#666", marginLeft: 22, marginTop: 2 }}>{o.desc}</div>
                </label>
              ))}
              {focus.length === 0 && <div style={{ fontSize: 12, color: "#b00" }}>※観点が0だと薄い出力になります（最低1つ推奨）</div>}
            </div>
          </div>
        </div>

        {/* Action */}
        <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center" }}>
          <button
            type="submit"
            disabled={loading}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #222",
              background: loading ? "#eee" : "#111",
              color: loading ? "#666" : "#fff",
              cursor: loading ? "not-allowed" : "pointer",
              fontWeight: 800,
            }}
          >
            {loading ? "分析中..." : "この設定で分析する"}
          </button>

          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setSingleFiles(null);
              setYearlyFile(null);
              setResult(null);
              setErr(null);
            }}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #bbb",
              background: "#fff",
              color: "#333",
              cursor: loading ? "not-allowed" : "pointer",
              fontWeight: 700,
            }}
          >
            リセット
          </button>

          {err && <div style={{ color: "#b00", fontWeight: 700 }}>{err}</div>}
        </div>
      </form>

      {/* Result */}
      {result && (
        <div style={{ marginTop: 18 }}>
          <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>結果</div>
            <div style={{ color: "#333" }}>{result.summary}</div>

            <div style={{ marginTop: 10, fontSize: 13, color: "#555" }}>
              設定：tone=<b>{result.selections?.tone}</b> / target=<b>{result.selections?.target}</b> / focus=
              <b>{(result.selections?.focus ?? []).join(", ") || "-"}</b>
            </div>

            {/* ✅ 追加：analysisMode / studentType / warnings（あれば表示） */}
            {(result.analysisMode || result.studentType || (result.warnings?.length ?? 0) > 0) && (
              <div style={{ marginTop: 10, fontSize: 13, color: "#444" }}>
                {result.analysisMode && (
                  <div>
                    モード：<b>{result.analysisMode}</b>
                  </div>
                )}
                {result.studentType && (
                  <div>
                    判定：<b>{result.studentType}</b>
                    {result.isTwoSubjectStudent ? "（2科目生）" : ""}
                  </div>
                )}
                {!!result.warnings?.length && (
                  <div style={{ marginTop: 6, padding: 10, borderRadius: 10, background: "#fff7d6" }}>
                    <b>注意：</b>
                    <ul style={{ margin: "6px 0 0 18px" }}>
                      {result.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {result.ocr?.note && (
              <div style={{ marginTop: 10, padding: 10, borderRadius: 10, background: "#fff7d6" }}>
                <b>注意：</b>
                {result.ocr.note}
              </div>
            )}

            {/* ✅ 追加：面談/配布/子ども向けレポート（reportsが返ってきたら表示） */}
            {result.reports && (
              <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }}>
                <ReportTabs reports={result.reports} />
              </div>
            )}
          </div>

          {/* ★追加：analysis表示（カットなし追記） */}
          {result?.analysis && (
            <div style={{ marginTop: 12 }}>
              <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>📊 集計（analysis）</div>

                <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 12 }}>
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>単発（複数）の集計</div>

                  {result.analysis.singles?.weakest ? (
                    <div style={{ marginBottom: 8 }}>
                      弱点（平均偏差値が低い）：
                      <b>
                        {result.analysis.singles.weakest.name}（
                        {typeof result.analysis.singles.weakest.avgDeviation === "number"
                          ? result.analysis.singles.weakest.avgDeviation.toFixed(1)
                          : "-"}
                        ）
                      </b>
                    </div>
                  ) : (
                    <div style={{ color: "#666", marginBottom: 8 }}>※単発の成績JSONがまだ取れていないため、集計できませんでした</div>
                  )}

                  {!!result.analysis.singles?.subjects?.length && (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "6px 0" }}>科目</th>
                          <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: "6px 0" }}>平均偏差値</th>
                          <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: "6px 0" }}>直近偏差値</th>
                          <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: "6px 0" }}>最低偏差値</th>
                          <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: "6px 0" }}>件数</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.analysis.singles.subjects.map((s: any) => (
                          <tr key={s.name}>
                            <td style={{ padding: "6px 0" }}>{s.name}</td>
                            <td style={{ textAlign: "right" }}>{typeof s.avgDeviation === "number" ? s.avgDeviation.toFixed(1) : "-"}</td>
                            <td style={{ textAlign: "right" }}>{typeof s.lastDeviation === "number" ? s.lastDeviation.toFixed(1) : "-"}</td>
                            <td style={{ textAlign: "right" }}>{typeof s.minDeviation === "number" ? s.minDeviation.toFixed(1) : "-"}</td>
                            <td style={{ textAlign: "right" }}>{s.count ?? 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 12, marginTop: 12 }}>
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>年間（1枚）の集計</div>

                  {result.analysis.yearly?.weakest ? (
                    <div>
                      弱点（偏差値が低い）：
                      <b>
                        {result.analysis.yearly.weakest.name}（
                        {typeof result.analysis.yearly.weakest.deviation === "number" ? result.analysis.yearly.weakest.deviation.toFixed(1) : "-"}
                        ）
                      </b>
                    </div>
                  ) : (
                    <div style={{ color: "#666" }}>※年間の成績JSONがまだ取れていないため、集計できませんでした</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* OCR / 判定 / JSON表示 */}
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {/* singles */}
            <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>単発（OCR/判定/JSON）</div>

              {result.ocr?.singles?.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {result.ocr.singles.map((r: any) => (
                    <div key={r.path} style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
                      <div style={{ fontWeight: 800 }}>{r.name}</div>
                      <div style={{ fontSize: 12, color: "#666" }}>{formatBytes(r.size)}</div>

                      {"ok" in r && r.ok === false && <div style={{ marginTop: 8, color: "#b00", fontWeight: 700 }}>OCR失敗：{r.error}</div>}

                      {"ok" in r && r.ok === true && (
                        <>
                          {r.gradeCheck && (
                            <div style={{ marginTop: 8, fontSize: 13 }}>
                              判定：{" "}
                              <b style={{ color: r.gradeCheck.isGradeReport ? "#0a0" : "#b00" }}>{r.gradeCheck.isGradeReport ? "成績表" : "成績表ではない"}</b>（信頼度{" "}
                              {r.gradeCheck.confidence}）<br />
                              <span style={{ color: "#555" }}>{r.gradeCheck.reason}</span>
                            </div>
                          )}

                          {/* JSON */}
                          {r.reportJson && (
                            <>
                              <div style={{ fontWeight: 800, marginTop: 10 }}>📦 抽出JSON</div>
                              <pre
                                style={{
                                  whiteSpace: "pre-wrap",
                                  background: "#f7f7f7",
                                  padding: 12,
                                  borderRadius: 10,
                                  marginTop: 6,
                                  fontSize: 12,
                                }}
                              >
                                {JSON.stringify(r.reportJson, null, 2)}
                              </pre>
                            </>
                          )}

                          {r.reportJsonMeta && !r.reportJson && <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>JSON化：{r.reportJsonMeta.error}</div>}

                          {/* OCR text */}
                          <details style={{ marginTop: 10 }}>
                            <summary style={{ cursor: "pointer", fontWeight: 700 }}>OCRテキストを表示</summary>
                            <pre
                              style={{
                                whiteSpace: "pre-wrap",
                                background: "#fcfcfc",
                                padding: 12,
                                borderRadius: 10,
                                marginTop: 6,
                                fontSize: 12,
                              }}
                            >
                              {r.text}
                            </pre>
                          </details>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ color: "#666" }}>単発の結果はありません</div>
              )}
            </div>

            {/* yearly */}
            <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>年間（OCR/判定/JSON）</div>

              {!result.files?.yearly ? (
                <div style={{ color: "#666" }}>年間はアップロードされていません</div>
              ) : (
                <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
                  <div style={{ fontWeight: 800 }}>{result.files.yearly.name}</div>
                  <div style={{ fontSize: 12, color: "#666" }}>{formatBytes(result.files.yearly.size)}</div>

                  {result.ocr?.yearlyGradeCheck && (
                    <div style={{ marginTop: 8, fontSize: 13 }}>
                      判定：{" "}
                      <b style={{ color: result.ocr.yearlyGradeCheck.isGradeReport ? "#0a0" : "#b00" }}>
                        {result.ocr.yearlyGradeCheck.isGradeReport ? "成績表" : "成績表ではない"}
                      </b>{" "}
                      （信頼度 {result.ocr.yearlyGradeCheck.confidence}）<br />
                      <span style={{ color: "#555" }}>{result.ocr.yearlyGradeCheck.reason}</span>
                    </div>
                  )}

                  {result.ocr?.yearlyReportJson && (
                    <>
                      <div style={{ fontWeight: 800, marginTop: 10 }}>📦 年間 抽出JSON</div>
                      <pre
                        style={{
                          whiteSpace: "pre-wrap",
                          background: "#f7f7f7",
                          padding: 12,
                          borderRadius: 10,
                          marginTop: 6,
                          fontSize: 12,
                        }}
                      >
                        {JSON.stringify(result.ocr.yearlyReportJson, null, 2)}
                      </pre>
                    </>
                  )}

                  {result.ocr?.yearlyReportJsonMeta && !result.ocr.yearlyReportJson && (
                    <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>JSON化：{result.ocr.yearlyReportJsonMeta.error}</div>
                  )}

                  {result.ocr?.yearly && (
                    <details style={{ marginTop: 10 }}>
                      <summary style={{ cursor: "pointer", fontWeight: 700 }}>OCRテキストを表示</summary>
                      <pre
                        style={{
                          whiteSpace: "pre-wrap",
                          background: "#fcfcfc",
                          padding: 12,
                          borderRadius: 10,
                          marginTop: 6,
                          fontSize: 12,
                        }}
                      >
                        {result.ocr.yearly}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
