import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

export const runtime = "nodejs";

/* =========================
   Clients
========================= */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* =========================
   Utils
========================= */
function safeName(name: string) {
  return name.replace(/[^\w.\-()]+/g, "_");
}

function clampNum(n: any, min: number, max: number): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function normalizeTestTypeLabel(s: string) {
  const t = String(s ?? "").replace(/\s+/g, "");
  if (/(育成テスト|学習力育成テスト|学習力育成|育成)/.test(t)) return "ikusei";
  if (/(公開模試|公開模擬試験|公開模試成績|公開)/.test(t)) return "kokai_moshi";
  return "other";
}

function extractSection(text: string, startPatterns: RegExp[], endPatterns: RegExp[]) {
  const lines = text.split(/\r?\n/);
  let startIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (startPatterns.some((re) => re.test(line))) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (endPatterns.some((re) => re.test(line))) {
      endIdx = i;
      break;
    }
  }

  const section = lines.slice(startIdx, endIdx).join("\n").trim();
  return section.length ? section : null;
}

/** キーワード出現行の「窓」を作る（見出しが崩れても拾える） */
function buildKeywordWindows(text: string, patterns: RegExp[], radius = 40, maxWindows = 6) {
  const lines = text.split(/\r?\n/);
  const hitIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (patterns.some((re) => re.test(line))) hitIdx.push(i);
  }

  // 近いヒットはまとめる
  const merged: Array<{ s: number; e: number }> = [];
  for (const idx of hitIdx) {
    const s = Math.max(0, idx - radius);
    const e = Math.min(lines.length, idx + radius + 1);
    const last = merged[merged.length - 1];
    if (last && s <= last.e + 5) {
      last.e = Math.max(last.e, e);
    } else {
      merged.push({ s, e });
    }
  }

  const picked = merged.slice(0, maxWindows);
  const chunks = picked.map(
    (w, k) => `【WINDOW${k + 1} L${w.s + 1}-L${w.e}】\n` + lines.slice(w.s, w.e).join("\n")
  );

  return {
    hits: hitIdx.map((i) => ({ lineNo: i + 1, text: lines[i] })).slice(0, 30),
    snippet: chunks.join("\n\n----------------\n\n").trim(),
  };
}

/** fallback（先頭/中央/末尾） */
function buildFallbackSnippet(text: string, headLines = 260, midLines = 260, tailLines = 260) {
  const lines = text.split(/\r?\n/);
  const total = lines.length;
  const head = lines.slice(0, headLines).join("\n");
  const midStart = Math.max(0, Math.floor(total / 2) - Math.floor(midLines / 2));
  const mid = lines.slice(midStart, Math.min(total, midStart + midLines)).join("\n");
  const tail = lines.slice(Math.max(0, total - tailLines)).join("\n");
  return `${head}\n\n...\n\n${mid}\n\n...\n\n${tail}`.slice(0, 16000);
}

/** テストの重複除去（同じ表を2回拾った時に1つにする） */
function dedupeTests(tests: any[]) {
  const seen = new Set<string>();
  const out: any[] = [];

  for (const t of tests ?? []) {
    const subj = Array.isArray(t?.subjects) ? t.subjects : [];
    const keyObj = {
      testType: t?.testType ?? null,
      testName: t?.testName ?? null,
      date: t?.date ?? null,
      subjects: subj
        .map((s: any) => ({
          name: s?.name ?? null,
          score: s?.score ?? null,
          avg: s?.avg ?? null,
          rank: s?.rank ?? null,
          deviation: s?.deviation ?? null,
          diffFromAvg: s?.diffFromAvg ?? null,
        }))
        .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name))),
      totals: t?.totals ?? null,
      notes: t?.notes ?? [],
    };
    const fp = JSON.stringify(keyObj);

    if (!seen.has(fp)) {
      seen.add(fp);
      out.push(t);
    }
  }

  return out;
}

/* =========================
   OCR (Supabase Storage PDF)
========================= */
async function ocrPdfFromStorage(params: { bucket: string; path: string; filename: string }) {
  const { bucket, path, filename } = params;

  const { data: pdfBlob, error } = await supabase.storage.from(bucket).download(path);
  if (error || !pdfBlob) throw new Error(`Supabase download failed: ${error?.message}`);

  const ab = await pdfBlob.arrayBuffer();
  const buf = Buffer.from(ab);

  const uploaded = await openai.files.create({
    file: await OpenAI.toFile(buf, filename, { type: "application/pdf" }),
    purpose: "assistants",
  });

  const resp = await openai.responses.create({
    model: "gpt-4.1",
    input: [
      {
        role: "user",
        content: [
          { type: "input_file", file_id: uploaded.id },
          {
            type: "input_text",
            // ★重要：この1枚PDFでも「表が途中で落ちる」を防ぐため、全ページ・省略禁止
            text:
              "このPDFはスキャン画像の可能性があります。必ず全ページをOCRし、ページ番号を付けて順番通りに全文を出力してください。要約は禁止。省略禁止。表は行・列が分かる形（可能ならMarkdown表）で転記してください。未記入は「空欄」と明記し、推測で埋めないでください。",
          },
        ],
      },
    ],
  });

  try {
    await openai.files.delete(uploaded.id);
  } catch {}

  return typeof resp.output_text === "string" ? resp.output_text : "";
}

/* =========================
   Types / Schemas
========================= */
type JukuReportJson = {
  docType: "juku_report";
  student: { name: string | null; id: string | null };
  meta: { sourceFilename: string | null; title: string | null };
  tests: Array<{
    testType: "ikusei" | "kokai_moshi" | "other";
    testName: string | null; // 例：育成テスト/公開模試/年間推移/合格力実践テスト など
    date: string | null; // 例：2025-06-29
    subjects: Array<{
      name: "国語" | "算数" | "理科" | "社会" | "不明";
      score: number | null;
      deviation: number | null;
      rank: number | null;
      avg: number | null;
      diffFromAvg: number | null;
    }>;
    totals: {
      two: {
        score: number | null;
        deviation: number | null;
        rank: number | null;
        avg: number | null;
        diffFromAvg: number | null;
        // ★追加：育成テスト（評価）用
        grade: number | null;
      };
      four: {
        score: number | null;
        deviation: number | null;
        rank: number | null;
        avg: number | null;
        diffFromAvg: number | null;
        // ★追加：育成テスト（評価）用
        grade: number | null;
      };
    };
    notes: string[];
  }>;
  notes: string[];
};

function safeParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const JUKU_REPORT_JSON_SCHEMA = {
  name: "JukuReportJson",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      docType: { type: "string", enum: ["juku_report"] },
      student: {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: ["string", "null"] }, id: { type: ["string", "null"] } },
        required: ["name", "id"],
      },
      meta: {
        type: "object",
        additionalProperties: false,
        properties: { sourceFilename: { type: ["string", "null"] }, title: { type: ["string", "null"] } },
        required: ["sourceFilename", "title"],
      },
      tests: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            testType: { type: "string", enum: ["ikusei", "kokai_moshi", "other"] },
            testName: { type: ["string", "null"] },
            date: { type: ["string", "null"] },
            subjects: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: { type: "string", enum: ["国語", "算数", "理科", "社会", "不明"] },
                  score: { type: ["number", "null"] },
                  deviation: { type: ["number", "null"] },
                  rank: { type: ["number", "null"] },
                  avg: { type: ["number", "null"] },
                  diffFromAvg: { type: ["number", "null"] },
                },
                required: ["name", "score", "deviation", "rank", "avg", "diffFromAvg"],
              },
            },
            totals: {
              type: "object",
              additionalProperties: false,
              properties: {
                two: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    score: { type: ["number", "null"] },
                    deviation: { type: ["number", "null"] },
                    rank: { type: ["number", "null"] },
                    avg: { type: ["number", "null"] },
                    diffFromAvg: { type: ["number", "null"] },
                    grade: { type: ["number", "null"] },
                  },
                  required: ["score", "deviation", "rank", "avg", "diffFromAvg", "grade"],
                },
                four: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    score: { type: ["number", "null"] },
                    deviation: { type: ["number", "null"] },
                    rank: { type: ["number", "null"] },
                    avg: { type: ["number", "null"] },
                    diffFromAvg: { type: ["number", "null"] },
                    grade: { type: ["number", "null"] },
                  },
                  required: ["score", "deviation", "rank", "avg", "diffFromAvg", "grade"],
                },
              },
              required: ["two", "four"],
            },
            notes: { type: "array", items: { type: "string" } },
          },
          required: ["testType", "testName", "date", "subjects", "totals", "notes"],
        },
      },
      notes: { type: "array", items: { type: "string" } },
    },
    required: ["docType", "student", "meta", "tests", "notes"],
  },
  strict: true,
} as const;

const JUDGE_JSON_SCHEMA = {
  name: "JudgeGradeReport",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      isGradeReport: { type: "boolean" },
      confidence: { type: "number" },
      reason: { type: "string" },
    },
    required: ["isGradeReport", "confidence", "reason"],
  },
  strict: true,
} as const;

/* =========================
   Extract report JSON (LLM)
========================= */
type ExtractResult =
  | { ok: true; reportJson: JukuReportJson; raw: string; error: null; debug: any }
  | { ok: false; reportJson: null; raw: string; error: string; debug: any };

async function extractJukuReportJsonFromText(params: { filename: string; extractedText: string }): Promise<ExtractResult> {
  const { filename, extractedText } = params;

  // この簡易推移は「I〜V」で構成されがちなので、それ以外にぶつかったら切る
  const endPatterns: RegExp[] = [
    /期末|中間|定期|評価|内申|5科|9科|英語|美術|保体|技家/,
    /欠席|遅刻|早退|出席率|教科出席率/,
    /^VI\.|^VII\./,
    /^＜/,
    /^【/,
  ];

  // ★育成：I（年間平均）＋ III（前期の回別一覧）
  const ikuseiSection = extractSection(
    extractedText,
    [
      /^I\.\s*前年度学習力育成テスト平均/i,
      /前年度学習力育成テスト平均/i,
      /^III\.\s*前期学習力育成テスト/i,
      /前期学習力育成テスト/i,
      /学習力育成テスト/i,
    ],
    endPatterns
  );

  // ★公開模試：V（回別一覧）＋ IV（平均）も補助として含める
  const kokaiSection = extractSection(
    extractedText,
    [
      /^V\.\s*公開模試成績/i,
      /公開模試成績/i,
      /^IV\.\s*前年度公開模擬平均/i,
      /前年度公開模擬平均/i,
      /公開模試/i,
      /公開模擬/i,
      /前期平均/i,
      /後期平均/i,
      /今年度平均/i,
      /年間平均/i,
    ],
    endPatterns
  );

  // 年間推移（偏差値推移のグラフ等）が別にある場合
  const yearlySection = extractSection(
    extractedText,
    [/総合学力診断テスト平均/i, /校内順位/i, /偏差値/i, /最近5回/i, /学力推移/i],
    endPatterns
  );

  const kwPrimary = buildKeywordWindows(
    extractedText,
    [
      /育成/i,
      /学習力育成/i,
      /公開模試/i,
      /公開模擬/i,
      /前期/i,
      /後期/i,
      /今年度/i,
      /年間/i,
      /回/i,
      /年/i,
      /月/i,
      /日/i,
      /4科/i,
      /2科/i,
      /得点/i,
      /偏差/i,
      /評価/i,
      /国語/i,
      /算数/i,
      /数学/i,
      /理科/i,
      /社会/i,
    ],
    55,
    6
  );

  const fallbackSnippet = buildFallbackSnippet(extractedText);

  const snippet =
    [
      ikuseiSection ? `【BLOCK:IKUSEI（育成テスト）】\n${ikuseiSection}` : null,
      kokaiSection ? `【BLOCK:KOKAI（公開模試）】\n${kokaiSection}` : null,
      yearlySection ? `【BLOCK:YEARLY（年間推移）】\n${yearlySection}` : null,
      kwPrimary.snippet ? `【BLOCK:KEYWORDS（補助）】\n${kwPrimary.snippet}` : null,
    ]
      .filter(Boolean)
      .join("\n\n----------------\n\n") || fallbackSnippet;

  const debug = {
    filename,
    hits: kwPrimary.hits,
    hasIkuseiSection: !!ikuseiSection,
    hasKokaiSection: !!kokaiSection,
    hasYearlySection: !!yearlySection,
    snippetPreview: snippet.slice(0, 2000),
  };

  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content:
          "あなたは中学受験塾の成績表データ化担当です。" +
          "OCRテキストから『育成テスト』『公開模試』『簡易推移（回ごとの一覧）』をJSON化します。" +
          "【最重要】この帳票は“1行＝1回分”の一覧表がある。必ず各行ごとに tests の要素を作ること。" +
          "【育成テスト】BLOCK:IKUSEI には、(回/年/月/日/4科/2科/得点/評価) が並ぶ表がある。各行から date(YYYY-MM-DD) を作り、totals.four.score と totals.four.grade、totals.two.score と totals.two.grade に入れる。偏差は無ければnull。" +
          "【公開模試】BLOCK:KOKAI には、(回/年/月/日/4科/2科/得点/偏差) が並ぶ表がある。各行から date(YYYY-MM-DD) を作り、totals.four.score と totals.four.deviation、totals.two.score と totals.two.deviation に入れる。評価は無ければnull。" +
          "【平均欄】前期平均/後期平均/今年度平均/年間平均があれば notes に文字列で保存する（例：'公開模試4科 前期=.. 後期=.. 年間=.. / 2科 前期=.. 後期=.. 年間=..'）。" +
          "【表記ゆれ】数学は算数として扱う。" +
          "【超重要】学校の定期テスト（期末/中間/定期/内申/5科/9科/英語/美術/保体/技家）は抽出しない。" +
          "推測は禁止。見えない/不明はnull。空欄はnull。",
      },
      {
        role: "user",
        content:
          `ファイル名: ${filename}\n\n` +
          "次のテキストから、育成テスト（評価）・公開模試（偏差）の“回ごと”成績を抽出してください。\n\n" +
          "テキスト:\n" +
          snippet,
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: JUKU_REPORT_JSON_SCHEMA.name,
        strict: true,
        schema: JUKU_REPORT_JSON_SCHEMA.schema,
      },
    },
  });

  const out = (resp.output_text ?? "").trim();
  const parsed = safeParseJson<JukuReportJson>(out);

  if (!parsed || parsed.docType !== "juku_report") {
    return { ok: false, reportJson: null, raw: out, error: "JSONの解析に失敗（フォーマット不正）", debug };
  }

  // ---- 後処理：type を確定させ、重複を落とす ----
  parsed.tests = (parsed.tests ?? []).map((t) => {
    const tt = normalizeTestTypeLabel(t.testType || t.testName || "other") as any;
    return { ...t, testType: tt };
  });

  // subjects の表記ゆれ補正（数学→算数）
  for (const t of parsed.tests ?? []) {
    t.subjects = (t.subjects ?? []).map((s: any) => {
      const rawName = String(s?.name ?? "").trim();
      const fixedName = rawName === "数学" ? "算数" : rawName;
      return { ...s, name: fixedName };
    });
  }

  // other は基本捨てる。ただし「年間推移」だけは残す（入ってきた場合）
  parsed.tests = (parsed.tests ?? []).filter((t) => t.testType !== "other" || t.testName === "年間推移");

  // 重複削除
  parsed.tests = dedupeTests(parsed.tests);

  // 並び順：育成→公開→その他
  const order: Record<string, number> = { ikusei: 0, kokai_moshi: 1, other: 9 };
  parsed.tests.sort((a: any, b: any) => {
    const oa = order[a.testType] ?? 9;
    const ob = order[b.testType] ?? 9;
    if (oa !== ob) return oa - ob;
    return String(a.date ?? "").localeCompare(String(b.date ?? ""));
  });

  // meta補正
  parsed.meta = parsed.meta ?? { sourceFilename: filename, title: null };
  if (parsed.meta.sourceFilename == null) parsed.meta.sourceFilename = filename;

  // 値のバリデーション
  for (const t of parsed.tests ?? []) {
    t.subjects = (t.subjects ?? []).map((s) => {
      const nameRaw = String(s?.name ?? "").trim();
      const normalizedName = nameRaw === "数学" ? "算数" : nameRaw;
      const name = (["国語", "算数", "理科", "社会"].includes(normalizedName) ? normalizedName : "不明") as any;

      return {
        ...s,
        name,
        score: clampNum(s.score, 0, 200),
        deviation: clampNum(s.deviation, 20, 80),
        rank: clampNum(s.rank, 1, 50000),
        avg: clampNum(s.avg, 0, 200),
        diffFromAvg: clampNum(s.diffFromAvg, -200, 200),
      };
    });

    const two = t.totals?.two ?? {
      score: null,
      deviation: null,
      rank: null,
      avg: null,
      diffFromAvg: null,
      grade: null,
    };
    const four = t.totals?.four ?? {
      score: null,
      deviation: null,
      rank: null,
      avg: null,
      diffFromAvg: null,
      grade: null,
    };

    t.totals.two = {
      score: clampNum(two.score, 0, 400),
      deviation: clampNum(two.deviation, 20, 80),
      rank: clampNum(two.rank, 1, 50000),
      avg: clampNum(two.avg, 0, 400),
      diffFromAvg: clampNum(two.diffFromAvg, -400, 400),
      grade: clampNum(two.grade, 0, 5), // 評価は多くの場合 1〜5 か 1〜4 なので広めに
    };

    t.totals.four = {
      score: clampNum(four.score, 0, 500),
      deviation: clampNum(four.deviation, 20, 80),
      rank: clampNum(four.rank, 1, 50000),
      avg: clampNum(four.avg, 0, 500),
      diffFromAvg: clampNum(four.diffFromAvg, -500, 500),
      grade: clampNum(four.grade, 0, 5),
    };

    t.notes = Array.isArray(t.notes) ? t.notes : [];
  }

  parsed.notes = Array.isArray(parsed.notes) ? parsed.notes : [];

  return { ok: true, reportJson: parsed, raw: out, error: null, debug };
}

/* =========================
   Judge grade report
========================= */
async function judgeGradeReport(params: { filename: string; extractedText: string }) {
  const { filename, extractedText } = params;

  const head = extractedText.slice(0, 4500);
  const tail = extractedText.slice(-4500);
  const snippet = `${head}\n...\n${tail}`;

  if (!snippet.trim()) {
    return { isGradeReport: false, confidence: 10, reason: "OCR結果がほぼ空でした（判定材料不足）" };
  }

  // ★この帳票は “育成/公開模試/学力診断/合格力” の単語が出る
  const mustHaveJukuSignal =
    /(学習力育成テスト|育成テスト|公開模試成績|公開模試|公開模擬|新学力観学力診断|学力診断|合格力実践テスト|合格力育成テスト)/.test(
      snippet
    );

  if (!mustHaveJukuSignal) {
    return {
      isGradeReport: false,
      confidence: 95,
      reason: "塾成績表に必須の見出し（育成/公開模試/学力診断/合格力等）が見当たらないため",
    };
  }

  const hasScoreSignals = /(偏差(値)?|順位|平均(点)?|得点|点数|2科|4科|評価)/.test(snippet);

  if (mustHaveJukuSignal && hasScoreSignals) {
    return { isGradeReport: true, confidence: 98, reason: "塾成績表の見出し＋得点/偏差/評価の記載が確認できたため" };
  }

  // ここまで来たら“ほぼ成績表”扱い
  return { isGradeReport: true, confidence: 80, reason: "塾成績表の見出しは確認できたが数値指標が弱いため" };
}

/* =========================
   Analysis (そのまま)
========================= */
type SubjectAgg = {
  name: string;
  count: number;
  avgDeviation: number | null;
  lastDeviation: number | null;
  minDeviation: number | null;
};

function safeNum(n: any): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function mergeAgg(a: SubjectAgg, dev: number | null): SubjectAgg {
  if (dev === null) return a;
  const newCount = a.count + 1;
  const newAvg = a.avgDeviation === null ? dev : (a.avgDeviation * a.count + dev) / newCount;
  const newMin = a.minDeviation === null ? dev : Math.min(a.minDeviation, dev);
  return { ...a, count: newCount, avgDeviation: newAvg, lastDeviation: dev, minDeviation: newMin };
}

function flattenJukuReportToSubjectsForAnalysis(juku: JukuReportJson | null) {
  if (!juku) return [];
  const rows: Array<{ name: string; deviation: number | null }> = [];
  for (const t of juku.tests ?? []) {
    for (const s of t.subjects ?? []) {
      const nm = String(s?.name ?? "").trim();
      if (!nm) continue;
      rows.push({ name: nm, deviation: safeNum(s?.deviation) });
    }
  }
  return rows;
}

function analyzeSinglesReportJson(singles: Array<{ reportJson?: any; filename?: string }>) {
  const map = new Map<string, SubjectAgg>();
  for (const s of singles) {
    const r = s.reportJson;
    if (!r || !Array.isArray(r.subjects)) continue;
    for (const subj of r.subjects) {
      const name = String(subj?.name ?? "").trim();
      if (!name) continue;
      const dev = safeNum(subj?.deviation);
      const cur =
        map.get(name) ??
        ({ name, count: 0, avgDeviation: null, lastDeviation: null, minDeviation: null } as SubjectAgg);
      map.set(name, mergeAgg(cur, dev));
    }
  }
  const subjects = Array.from(map.values());
  subjects.sort((a, b) => (a.avgDeviation ?? 9999) - (b.avgDeviation ?? 9999));
  const weakest = subjects[0]?.avgDeviation != null ? subjects[0] : null;
  return { subjects, weakest };
}

function analyzeYearlyReportJson(yearly: any) {
  if (yearly && yearly.docType === "juku_report") {
    const rows = flattenJukuReportToSubjectsForAnalysis(yearly as JukuReportJson);
    const map = new Map<string, SubjectAgg>();
    for (const row of rows) {
      const name = String(row.name ?? "").trim();
      if (!name) continue;
      const dev = safeNum(row.deviation);
      const cur =
        map.get(name) ??
        ({ name, count: 0, avgDeviation: null, lastDeviation: null, minDeviation: null } as SubjectAgg);
      map.set(name, mergeAgg(cur, dev));
    }
    const subjects = Array.from(map.values());
    subjects.sort((a, b) => (a.avgDeviation ?? 9999) - (b.avgDeviation ?? 9999));
    const weakest = subjects[0]?.avgDeviation != null ? subjects[0] : null;
    return { subjects, weakest };
  }
  return { subjects: [], weakest: null };
}

/* =========================
   Commentary (そのまま)
========================= */
type Tone = "gentle" | "balanced" | "strict";
type Target = "student" | "parent" | "teacher";
type FocusAxis = "mistake" | "process" | "knowledge" | "attitude";

function toneLabel(t: Tone) {
  if (t === "gentle") return "優しめ（共感多め）";
  if (t === "strict") return "厳しめ（改善点を明確に）";
  return "バランス（優しさ7：厳しさ3）";
}
function targetLabel(t: Target) {
  if (t === "parent") return "保護者向け";
  if (t === "teacher") return "講師/社内向け";
  return "子ども向け";
}
function focusLabel(f: FocusAxis) {
  switch (f) {
    case "mistake":
      return "ミス分析";
    case "process":
      return "思考プロセス";
    case "knowledge":
      return "知識/定着";
    case "attitude":
      return "姿勢/習慣";
    default:
      return f;
  }
}

async function generateCommentary(params: {
  tone: Tone;
  target: Target;
  focus: FocusAxis[];
  singleAnalysis: any;
  yearlyAnalysis: any;
  singlesReportJson: Array<{ name: string; reportJson: any | null }>;
  yearlyReportJson: any | null;
}) {
  const { tone, target, focus, singleAnalysis, yearlyAnalysis, singlesReportJson, yearlyReportJson } = params;

  const payload = {
    settings: {
      tone,
      toneLabel: toneLabel(tone),
      target,
      targetLabel: targetLabel(target),
      focus: focus.map((x) => ({ key: x, label: focusLabel(x) })),
    },
    analysis: { singles: singleAnalysis, yearly: yearlyAnalysis },
    singles: singlesReportJson.map((x) => ({ name: x.name, reportJson: x.reportJson })),
    yearly: yearlyReportJson,
  };

  const system = `
あなたは中学受験算数のプロ講師「まなぶ先生AI」です。
・ミスは責めず「次に伸びるヒント」にする
・優しさ7：厳しさ3
・tone/target/focusを反映
・根拠のない断定は禁止（nullは未取得とする）
  `.trim();

  const user = `
以下は受験塾の成績表JSON（育成テスト/公開模試）と集計結果です。
このデータを元に講評を書いてください。

【データ(JSON)】
${JSON.stringify(payload, null, 2)}
`.trim();

  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  return typeof resp.output_text === "string" ? resp.output_text.trim() : "";
}

/* =========================
   Handler
========================= */
export async function POST(req: NextRequest) {
  try {
    const fd = await req.formData();

    const singleFiles = fd
      .getAll("single")
      .filter((v: FormDataEntryValue): v is File => v instanceof File);

    const yearlyFileRaw = fd.get("yearly");
    const yearlyFile = yearlyFileRaw instanceof File ? yearlyFileRaw : null;

    const tone = (fd.get("tone")?.toString() ?? "gentle") as Tone;
    const target = (fd.get("target")?.toString() ?? "student") as Target;

    let focus: FocusAxis[] = [];
    try {
      focus = JSON.parse(fd.get("focus")?.toString() ?? "[]");
      if (!Array.isArray(focus)) focus = [];
    } catch {
      focus = [];
    }

    if (singleFiles.length === 0 && !yearlyFile) {
      return new NextResponse("PDFがありません。", { status: 400 });
    }

    const bucket = process.env.SUPABASE_PDF_BUCKET ?? "report-pdfs";
    const baseDir = `analyze/${crypto.randomUUID()}`;

    async function upload(file: File) {
      const ab = await file.arrayBuffer();
      const path = `${baseDir}/${safeName(file.name)}`;
      const { error } = await supabase.storage.from(bucket).upload(path, ab, {
        contentType: file.type || "application/pdf",
        upsert: true,
      });
      if (error) throw new Error(error.message);
      return { path, name: file.name, size: file.size };
    }

    const uploadedSingles: { path: string; name: string; size: number }[] = [];
    for (const f of singleFiles) uploadedSingles.push(await upload(f));
    const uploadedYearly = yearlyFile ? await upload(yearlyFile) : null;

    const MAX_SINGLE_OCR = 5;
    const singleTargets = uploadedSingles.slice(0, MAX_SINGLE_OCR);

    const singleOcrResults: any[] = [];
    for (const f of singleTargets) {
      try {
        const text = await ocrPdfFromStorage({ bucket, path: f.path, filename: f.name });
        const gradeCheck = await judgeGradeReport({ filename: f.name, extractedText: text });

        let reportJson: any | null = null;
        let reportJsonMeta: { ok: boolean; error: string | null } | null = null;
        let debug: any | null = null;

        if (gradeCheck.isGradeReport) {
          const extracted = await extractJukuReportJsonFromText({ filename: f.name, extractedText: text });
          reportJson = extracted.reportJson;
          reportJsonMeta = { ok: extracted.ok, error: extracted.ok ? null : extracted.error ?? "JSON化に失敗" };
          debug = extracted.debug;
        } else {
          reportJson = null;
          reportJsonMeta = { ok: false, error: "成績表ではないためJSON化をスキップ" };
        }

        singleOcrResults.push({ ...f, ok: true, text, gradeCheck, reportJson, reportJsonMeta, debug });
      } catch (e: any) {
        console.error("[single OCR error]", f?.name, e);
        singleOcrResults.push({
          ...f,
          ok: false,
          error: e?.message ?? "OCR error",
          gradeCheck: { isGradeReport: false, confidence: 0, reason: "OCRに失敗したため判定できません" },
        });
      }
    }

    let yearlyOcrText: string | null = null;
    let yearlyOcrError: string | null = null;

    let yearlyGradeCheck: { isGradeReport: boolean; confidence: number; reason: string } | null = null;
    let yearlyReportJson: any | null = null;
    let yearlyReportJsonMeta: { ok: boolean; error: string | null } | null = null;
    let yearlyDebug: any | null = null;

    if (uploadedYearly) {
      try {
        yearlyOcrText = await ocrPdfFromStorage({ bucket, path: uploadedYearly.path, filename: uploadedYearly.name });
      } catch (e: any) {
        yearlyOcrText = null;
        yearlyOcrError = e?.message ?? "yearly OCR error";
        console.error("[yearly OCR error]", uploadedYearly?.name, e);
      }

      if (yearlyOcrText) {
        yearlyGradeCheck = await judgeGradeReport({ filename: uploadedYearly.name, extractedText: yearlyOcrText });

        if (yearlyGradeCheck.isGradeReport) {
          const extracted = await extractJukuReportJsonFromText({
            filename: uploadedYearly.name,
            extractedText: yearlyOcrText,
          });
          yearlyReportJson = extracted.reportJson;
          yearlyReportJsonMeta = { ok: extracted.ok, error: extracted.ok ? null : extracted.error ?? "JSON化に失敗" };
          yearlyDebug = extracted.debug;
        } else {
          yearlyReportJson = null;
          yearlyReportJsonMeta = { ok: false, error: "成績表ではないためJSON化をスキップ" };
        }
      } else {
        yearlyGradeCheck = { isGradeReport: false, confidence: 0, reason: "OCRに失敗したため判定できません" };
      }
    }

    const singleJsonItems = (singleOcrResults ?? []).map((x: any) => {
      const r = x.reportJson;
      if (r && r.docType === "juku_report") {
        const rows = flattenJukuReportToSubjectsForAnalysis(r as JukuReportJson);
        return { filename: x.name, reportJson: { subjects: rows.map((row) => ({ name: row.name, deviation: row.deviation })) } };
      }
      return { filename: x.name, reportJson: x.reportJson };
    });

    const singleAnalysis = analyzeSinglesReportJson(singleJsonItems);
    const yearlyAnalysis = analyzeYearlyReportJson(yearlyReportJson);

    const singlesReportJson = (singleOcrResults ?? []).map((x: any) => ({
      name: x.name,
      reportJson: x.reportJson as any | null,
    }));

    const hasAnyReportJson = singlesReportJson.some((x) => !!x.reportJson) || !!yearlyReportJson;

    const commentary = hasAnyReportJson
      ? await generateCommentary({
          tone,
          target,
          focus,
          singleAnalysis,
          yearlyAnalysis,
          singlesReportJson,
          yearlyReportJson,
        })
      : "成績表として読み取れたデータがまだありません。成績表PDFを入れてもう一度試してみてください。";

    return NextResponse.json({
      summary: `単発=${uploadedSingles.length}枚 / 年間=${uploadedYearly ? "あり" : "なし"}`,
      files: { singles: uploadedSingles, yearly: uploadedYearly },
      ocr: {
        singles: singleOcrResults,
        yearly: yearlyOcrText,
        yearlyError: yearlyOcrError,
        yearlyGradeCheck,
        yearlyReportJson,
        yearlyReportJsonMeta,
        yearlyDebug,
        note: uploadedSingles.length > MAX_SINGLE_OCR ? `単発PDFが多いため、先頭${MAX_SINGLE_OCR}枚のみOCRしました` : null,
      },
      selections: { tone, focus, target },
      analysis: { singles: singleAnalysis, yearly: yearlyAnalysis },
      commentary,
    });
  } catch (e: any) {
    console.error("[route POST fatal]", e);
    return new NextResponse(e?.message ?? "Server error", { status: 500 });
  }
}
