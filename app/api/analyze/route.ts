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
  if (/(育成テスト|学習力育成テスト)/.test(t)) return "ikusei";
  if (/(公開模試|公開模擬試験)/.test(t)) return "kokai_moshi";
  return "other";
}

/** OCRテキストから指定セクションを切り出す（混線防止） */
function extractSection(
  text: string,
  startPatterns: RegExp[],
  endPatterns: RegExp[]
) {
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

/** Supabase Storage 上のPDFをOCR */
async function ocrPdfFromStorage(params: {
  bucket: string;
  path: string;
  filename: string;
}) {
  const { bucket, path, filename } = params;

  const { data: pdfBlob, error } = await supabase.storage
    .from(bucket)
    .download(path);
  if (error || !pdfBlob) {
    throw new Error(`Supabase download failed: ${error?.message}`);
  }

  const ab = await pdfBlob.arrayBuffer();
  const buf = Buffer.from(ab);

  // ★ TS2345 対策：purpose 必須
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
            text:
              "このPDFはスキャン画像の可能性があります。OCRして、表の項目名と数値を漏れなくテキスト化してください。" +
              "未記入は「空欄」と明記し、推測で埋めないでください。",
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
    testName: string | null;
    date: string | null;
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
      };
      four: {
        score: number | null;
        deviation: number | null;
        rank: number | null;
        avg: number | null;
        diffFromAvg: number | null;
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
        properties: {
          name: { type: ["string", "null"] },
          id: { type: ["string", "null"] },
        },
        required: ["name", "id"],
      },
      meta: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceFilename: { type: ["string", "null"] },
          title: { type: ["string", "null"] },
        },
        required: ["sourceFilename", "title"],
      },
      tests: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            testType: {
              type: "string",
              enum: ["ikusei", "kokai_moshi", "other"],
            },
            testName: { type: ["string", "null"] },
            date: { type: ["string", "null"] },
            subjects: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: {
                    type: "string",
                    enum: ["国語", "算数", "理科", "社会", "不明"],
                  },
                  score: { type: ["number", "null"] },
                  deviation: { type: ["number", "null"] },
                  rank: { type: ["number", "null"] },
                  avg: { type: ["number", "null"] },
                  diffFromAvg: { type: ["number", "null"] },
                },
                required: [
                  "name",
                  "score",
                  "deviation",
                  "rank",
                  "avg",
                  "diffFromAvg",
                ],
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
                  },
                  required: ["score", "deviation", "rank", "avg", "diffFromAvg"],
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
                  },
                  required: ["score", "deviation", "rank", "avg", "diffFromAvg"],
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
   Extract report JSON
========================= */

// ★ここが TS2339対策：成功/失敗どちらも error を必ず持つ
type ExtractResult =
  | {
      ok: true;
      reportJson: JukuReportJson;
      raw: string;
      error: null;
    }
  | {
      ok: false;
      reportJson: null;
      raw: string;
      error: string;
    };

async function extractJukuReportJsonFromText(params: {
  filename: string;
  extractedText: string;
}): Promise<ExtractResult> {
  const { filename, extractedText } = params;

  const endPatterns = [
    /^II\./,
    /^III\./,
    /^IV\./,
    /^V\./,
    /^VI\./,
    /^VII\./,
    /^期末テスト/,
    /^累計/,
    /^欠席/,
    /^出席率/,
    /^＜/,
    /^【/,
  ];

  const ikuseiSection = extractSection(
    extractedText,
    [/育成テスト|学習力育成テスト/],
    endPatterns
  );

  const kokaiSection = extractSection(
    extractedText,
    [/公開模試|公開模擬試験/],
    endPatterns
  );

  const fallbackHead = extractedText.slice(0, 5000);
  const fallbackTail = extractedText.slice(-5000);
  const fallbackSnippet = `${fallbackHead}\n...\n${fallbackTail}`;

  const snippet =
    [
      ikuseiSection ? `【育成テストブロック】\n${ikuseiSection}` : null,
      kokaiSection ? `【公開模試ブロック】\n${kokaiSection}` : null,
    ]
      .filter(Boolean)
      .join("\n\n----------------\n\n") || fallbackSnippet;

  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content:
          "あなたは中学受験塾の成績表データ化担当です。OCRテキストから『育成テスト』『公開模試』の成績を構造化JSONにします。" +
          "推測は禁止。見えない/不明はnull。空欄はnull。" +
          "対象は 国語/算数/理科/社会 と 2科/4科（合計・偏差(偏差値)・順位・平均点・平均との差）。" +
          "『偏差』表記も deviation として扱う。",
      },
      {
        role: "user",
        content:
          `ファイル名: ${filename}\n\n` +
          "次のテキストから、受験塾（育成テスト/公開模試）の成績情報を抽出してください。\n" +
          "注意：学校の5科9科、英語、美術、体育などは無視。\n\n" +
          "テキスト:\n" +
          snippet,
      },
    ],
    // ★ response_format は使わず text.format を使う（あなたのエラー対策）
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
    return {
      ok: false,
      reportJson: null,
      raw: out,
      error: "JSONの解析に失敗（フォーマット不正）",
    };
  }

  // バリデーション（変な値をnullにする）
  parsed.meta = parsed.meta ?? { sourceFilename: filename, title: null };
  if (parsed.meta.sourceFilename == null) parsed.meta.sourceFilename = filename;

  for (const t of parsed.tests ?? []) {
    t.testType = normalizeTestTypeLabel(t.testType) as any;

    t.subjects = (t.subjects ?? []).map((s) => {
      const name = (["国語", "算数", "理科", "社会"].includes(s.name)
        ? s.name
        : "不明") as any;

      const score = clampNum(s.score, 0, 200);
      const deviation = clampNum(s.deviation, 20, 80);
      const rank = clampNum(s.rank, 1, 50000);
      const avg = clampNum(s.avg, 0, 200);
      const diffFromAvg = clampNum(s.diffFromAvg, -200, 200);

      return { ...s, name, score, deviation, rank, avg, diffFromAvg };
    });

    const two =
      t.totals?.two ?? {
        score: null,
        deviation: null,
        rank: null,
        avg: null,
        diffFromAvg: null,
      };
    const four =
      t.totals?.four ?? {
        score: null,
        deviation: null,
        rank: null,
        avg: null,
        diffFromAvg: null,
      };

    t.totals.two = {
      score: clampNum(two.score, 0, 400),
      deviation: clampNum(two.deviation, 20, 80),
      rank: clampNum(two.rank, 1, 50000),
      avg: clampNum(two.avg, 0, 400),
      diffFromAvg: clampNum(two.diffFromAvg, -400, 400),
    };

    t.totals.four = {
      score: clampNum(four.score, 0, 500),
      deviation: clampNum(four.deviation, 20, 80),
      rank: clampNum(four.rank, 1, 50000),
      avg: clampNum(four.avg, 0, 500),
      diffFromAvg: clampNum(four.diffFromAvg, -500, 500),
    };

    t.notes = Array.isArray(t.notes) ? t.notes : [];
  }

  parsed.notes = Array.isArray(parsed.notes) ? parsed.notes : [];

  // ✅成功時も error:null を返す（TS2339解消）
  return { ok: true, reportJson: parsed, raw: out, error: null };
}

/* =========================
   Judge grade report（誤判定対策済み）
========================= */
async function judgeGradeReport(params: { filename: string; extractedText: string }) {
  const { filename, extractedText } = params;

  const head = extractedText.slice(0, 4500);
  const tail = extractedText.slice(-4500);
  const snippet = `${head}\n...\n${tail}`;

  if (!snippet.trim()) {
    return { isGradeReport: false, confidence: 10, reason: "OCR結果がほぼ空でした（判定材料不足）" };
  }

  const hasJukuKeywords =
    /(育成テスト|学習力育成テスト|公開模試|公開模擬試験)/.test(snippet);

  const hasScoreSignals =
    /(偏差(値)?|順位|平均(点)?|平均との差|得点|点数|2科|4科|国語|算数|理科|社会)/.test(snippet);

  const strongExamDocSignals =
    /(問題用紙|解答用紙|解答欄|設問|大問|小問|配点|注意事項|試験問題|問題冊子)/.test(snippet);

  if (hasJukuKeywords && hasScoreSignals) {
    return {
      isGradeReport: true,
      confidence: 98,
      reason: "育成テスト/公開模試と、偏差・順位・平均・得点など成績表の根拠語が確認できたため",
    };
  }

  if (strongExamDocSignals && !hasScoreSignals) {
    return {
      isGradeReport: false,
      confidence: 90,
      reason: "問題用紙/解答用紙/設問/配点/注意事項など試験資料の特徴が強く、成績指標語が弱いため",
    };
  }

  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content:
          "あなたは受験塾の成績表判定担当です。『学習相談』のように本文に「問題/解答/配点」が混ざる場合でも、" +
          "育成テスト/公開模試/偏差/順位/平均/得点/2科4科 が揃っていれば成績表として判定してください。",
      },
      {
        role: "user",
        content:
          "ファイル名: " +
          filename +
          "\n\nOCRテキスト（抜粋）:\n" +
          snippet +
          "\n\n判定基準：\n" +
          "・成績表の根拠：育成テスト/公開模試、偏差(値)、順位、平均点/平均との差、得点、2科/4科、国語/算数/理科/社会\n" +
          "・試験資料の根拠：問題用紙、解答用紙、設問、大問小問、配点、注意事項、問題冊子\n",
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: JUDGE_JSON_SCHEMA.name,
        strict: true,
        schema: JUDGE_JSON_SCHEMA.schema,
      },
    },
  });

  const txt = (resp.output_text ?? "").trim();
  try {
    const obj = JSON.parse(txt);
    return {
      isGradeReport: Boolean(obj.isGradeReport),
      confidence: Number.isFinite(obj.confidence) ? Math.max(0, Math.min(100, Number(obj.confidence))) : 50,
      reason: typeof obj.reason === "string" ? obj.reason : "理由の取得に失敗しました",
    };
  } catch {
    return { isGradeReport: false, confidence: 30, reason: "判定JSONの解析に失敗（フォーマット不正）" };
  }
}

/* =========================
   Analysis (集計)
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

  if (!yearly || !Array.isArray(yearly.subjects)) return { subjects: [], weakest: null };

  const subjects = yearly.subjects
    .map((s: any) => ({
      name: String(s?.name ?? "").trim(),
      deviation: safeNum(s?.deviation),
      score: safeNum(s?.score),
      avg: safeNum(s?.avg),
      rank: safeNum(s?.rank),
    }))
    .filter((s: any) => s.name);

  const sorted = [...subjects].sort((a, b) => {
    const av = a.deviation ?? 9999;
    const bv = b.deviation ?? 9999;
    return av - bv;
  });

  return { subjects, weakest: sorted[0]?.deviation != null ? sorted[0] : null };
}

/* =========================
   Commentary
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

    const singleFiles = fd.getAll("single").filter((v): v is File => v instanceof File);
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

        if (gradeCheck.isGradeReport) {
          const extracted = await extractJukuReportJsonFromText({ filename: f.name, extractedText: text });
          reportJson = extracted.reportJson;
          reportJsonMeta = { ok: extracted.ok, error: extracted.ok ? null : extracted.error ?? "JSON化に失敗" };
        } else {
          reportJson = null;
          reportJsonMeta = { ok: false, error: "成績表ではないためJSON化をスキップ" };
        }

        singleOcrResults.push({ ...f, ok: true, text, gradeCheck, reportJson, reportJsonMeta });
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
    let yearlyJudgeError: string | null = null;

    let yearlyGradeCheck: { isGradeReport: boolean; confidence: number; reason: string } | null = null;
    let yearlyReportJson: any | null = null;
    let yearlyReportJsonMeta: { ok: boolean; error: string | null } | null = null;

    if (uploadedYearly) {
      try {
        yearlyOcrText = await ocrPdfFromStorage({ bucket, path: uploadedYearly.path, filename: uploadedYearly.name });
      } catch (e: any) {
        yearlyOcrText = null;
        yearlyOcrError = e?.message ?? "yearly OCR error";
        console.error("[yearly OCR error]", uploadedYearly?.name, e);
      }

      if (yearlyOcrText) {
        try {
          yearlyGradeCheck = await judgeGradeReport({ filename: uploadedYearly.name, extractedText: yearlyOcrText });
        } catch (e: any) {
          yearlyGradeCheck = { isGradeReport: false, confidence: 0, reason: "判定に失敗したため判定できません" };
          yearlyJudgeError = e?.message ?? "yearly judge error";
          console.error("[yearly judge error]", uploadedYearly?.name, e);
        }

        try {
          if (yearlyGradeCheck?.isGradeReport) {
            const extracted = await extractJukuReportJsonFromText({
              filename: uploadedYearly.name,
              extractedText: yearlyOcrText,
            });
            yearlyReportJson = extracted.reportJson;
            yearlyReportJsonMeta = { ok: extracted.ok, error: extracted.ok ? null : extracted.error ?? "JSON化に失敗" };
          } else {
            yearlyReportJson = null;
            yearlyReportJsonMeta = { ok: false, error: "成績表ではないためJSON化をスキップ" };
          }
        } catch (e: any) {
          console.error("[yearly JSON error]", uploadedYearly?.name, e);
          yearlyReportJson = null;
          yearlyReportJsonMeta = { ok: false, error: e?.message ?? "JSON化エラー" };
        }
      } else {
        yearlyGradeCheck = { isGradeReport: false, confidence: 0, reason: "OCRに失敗したため判定できません" };
      }
    }

    const singleJsonItems = (singleOcrResults ?? []).map((x: any) => {
      const r = x.reportJson;
      if (r && r.docType === "juku_report") {
        const rows = flattenJukuReportToSubjectsForAnalysis(r as JukuReportJson);
        return {
          filename: x.name,
          reportJson: { subjects: rows.map((row) => ({ name: row.name, deviation: row.deviation })) },
        };
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
        yearlyJudgeError,
        yearlyGradeCheck,
        yearlyReportJson,
        yearlyReportJsonMeta,
        note:
          uploadedSingles.length > MAX_SINGLE_OCR
            ? `単発PDFが多いため、先頭${MAX_SINGLE_OCR}枚のみOCRしました`
            : null,
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
