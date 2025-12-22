/// <reference types="node" />
import { Buffer } from "buffer";
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

function toNumberOrNull(v: any): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.replace(/[^\d.\-]/g, "");
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clampNum(n: any, min: number, max: number): number | null {
  const v = toNumberOrNull(n);
  if (v === null) return null;
  if (v < min || v > max) return null;
  return v;
}

function safeParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function normalizeTestTypeLabel(s: string) {
  const t = String(s ?? "").replace(/\s+/g, "");
  if (/(学習力育成テスト|育成テスト|学習力育成|育成)/.test(t)) return "ikusei";
  if (/(公開模試|公開模擬試験|公開模試成績|公開)/.test(t)) return "kokai_moshi";
  return "other";
}

function isGakuhanLike(s: string) {
  const t = String(s ?? "").replace(/\s+/g, "");
  return /(学判|学力判定|学力診断|学力到達度|到達度テスト)/.test(t);
}

function parseYmdLoose(s: string): string | null {
  // "2025 2/16" / "2025 2 9" / "2025 10 5" などを許容して YYYY-MM-DD にする
  const t = String(s ?? "").trim();
  const m = t.match(/(20\d{2})\s*[\/\-\.\s]\s*(\d{1,2})\s*[\/\-\.\s]\s*(\d{1,2})/);
  if (!m) return null;
  const yy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  if (!Number.isFinite(yy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${String(yy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

function sliceBetween(text: string, startMarker: RegExp, endMarker: RegExp) {
  const start = text.search(startMarker);
  if (start < 0) return "";
  const sub = text.slice(start);
  const end = sub.search(endMarker);
  if (end < 0) return sub;
  return sub.slice(0, end);
}

/* =========================
   JSON Types / Schema
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
      name: string | null;
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
        grade: number | null;
      };
      four: {
        score: number | null;
        deviation: number | null;
        rank: number | null;
        avg: number | null;
        diffFromAvg: number | null;
        grade: number | null;
      };
    };
    notes: string[];
  }>;
  notes: string[];
};

/**
 * ✅ docType に type を必ず入れる（これが無いと 400 schema error）
 */
const JUKU_REPORT_JSON_SCHEMA = {
  name: "juku_report_json",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      docType: { type: "string", const: "juku_report" },
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
      tests: { type: "array" },
      notes: { type: "array", items: { type: "string" } },
    },
    required: ["docType", "student", "meta", "tests", "notes"],
  },
  strict: true,
} as const;

/* =========================
   Assumed averages（平均点が載っていない前提）
========================= */
const ASSUMED_AVERAGE = {
  kokaiDeviationAvg: 50, // 公開模試：偏差50が平均
  ikuseiGradeAvg: 6, // 育成：平均評価を6とみなす（運用ルール）
};

/* =========================
   ★安全弁：幻覚値の排除＆2科のみ回は4科null
========================= */
function nullifyFieldsByType(t: any) {
  // 育成は score + grade のみ（avg/diffFromAvg は採用しない）
  if (t.testType === "ikusei") {
    if (t?.totals?.two) {
      t.totals.two.avg = null;
      t.totals.two.diffFromAvg = null;
      t.totals.two.deviation = null;
    }
    if (t?.totals?.four) {
      t.totals.four.avg = null;
      t.totals.four.diffFromAvg = null;
      t.totals.four.deviation = null;
    }
  }

  // 公開は score + deviation のみ（grade/avg/diffFromAvg は採用しない）
  if (t.testType === "kokai_moshi") {
    if (t?.totals?.two) {
      t.totals.two.grade = null;
      t.totals.two.avg = null;
      t.totals.two.diffFromAvg = null;
    }
    if (t?.totals?.four) {
      t.totals.four.grade = null;
      t.totals.four.avg = null;
      t.totals.four.diffFromAvg = null;
    }
  }
}

function forceNullifyFourIfMissing(t: any) {
  // 4科が空欄の回は、4科をnullに
  if (!t?.totals?.four) return;
  const fourScore = toNumberOrNull(t.totals.four.score);
  const fourDev = toNumberOrNull(t.totals.four.deviation);
  const fourGrade = toNumberOrNull(t.totals.four.grade);
  if (fourScore == null && fourDev == null && fourGrade == null) {
    t.totals.four = {
      score: null,
      deviation: null,
      rank: null,
      avg: null,
      diffFromAvg: null,
      grade: null,
    };
  }
}

/* =========================
   OCR（PDFを input_file で渡す：必須）
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

  try {
    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_file", file_id: uploaded.id },
            {
              type: "input_text",
              text:
                "PDFをページ番号付きでOCR転記してください。要約禁止。推測禁止。省略禁止。表は可能な限り表形式で。",
            },
          ],
        },
      ],
    });

    return typeof resp.output_text === "string" ? resp.output_text.trim() : "";
  } finally {
    try {
      await openai.files.delete(uploaded.id);
    } catch {}
  }
}

/* =========================
   ★追加：OCRテキストから“確実に”育成/公開の行を抽出してJSON化
   - LLMに表の行生成を任せない（取りこぼし防止）
========================= */
function buildYearlyFromOcrText(ocrText: string, sourceFilename: string): JukuReportJson {
  const yearly: JukuReportJson = {
    docType: "juku_report",
    student: { name: null, id: null },
    meta: { sourceFilename, title: null },
    tests: [],
    notes: [],
  };

  // 1) 育成（III. 前期学習力育成テスト出題範囲及び成績）だけ切り出し
  const ikuseiBlock = sliceBetween(
    ocrText,
    /III\.\s*前期学習力育成テスト出題範囲及び成績/i,
    /合格力実践テスト/i
  );

  // 形式例：
  // | 1 | 2025 2/16 | 131 | 4 | 65 | 4 | ...
  // 回数 | 日付 | 4科得点 | 評価 | 2科得点 | 評価 |
  const ikuseiRowRe =
    /\|\s*(\d{1,2})\s*\|\s*(20\d{2}\s*[\d\/\s]{1,6}\d{1,2})\s*\|\s*([0-9]{1,3})\s*\|\s*([0-9]{1,2})\s*\|\s*([0-9]{1,3})\s*\|\s*([0-9]{1,2})\s*\|/g;

  for (const m of ikuseiBlock.matchAll(ikuseiRowRe)) {
    const n = Number(m[1]);
    const date = parseYmdLoose(m[2]);
    const fourScore = clampNum(Number(m[3]), 0, 500);
    const fourGrade = clampNum(Number(m[4]), 0, 10);
    const twoScore = clampNum(Number(m[5]), 0, 400);
    const twoGrade = clampNum(Number(m[6]), 0, 10);

    // 「2科だけ」「4科だけ」両対応：空欄ならnullにしたいが、この正規表現は両方ある行だけ拾う。
    // もし将来「4科空欄」行がある場合は正規表現を追加で拾う（必要になったら足す）
    const t: any = {
      testType: "ikusei",
      testName: `第${n}回育成テスト`,
      date,
      subjects: [],
      totals: {
        two: { score: twoScore, deviation: null, rank: null, avg: null, diffFromAvg: null, grade: twoGrade },
        four: { score: fourScore, deviation: null, rank: null, avg: null, diffFromAvg: null, grade: fourGrade },
      },
      notes: [],
    };

    nullifyFieldsByType(t);
    forceNullifyFourIfMissing(t);

    yearly.tests.push(t);
  }

  // 2) 公開（V. 公開模試成績）だけ切り出し
  const kokaiBlock = sliceBetween(ocrText, /V\.\s*公開模試成績/i, /合格力育成テスト/i);

  // 形式例：
  // | 1 | 2025 2 9 | 49 | 28 |  |  |
  // 回 | 年月日 | 4科得点 | 偏差 | 2科得点 | 偏差 |
  const kokaiRowRe =
    /\|\s*(\d{1,2})\s*\|\s*(20\d{2}\s*[\d\/\s]{1,6}\d{1,2})\s*\|\s*([0-9]{1,3})\s*\|\s*([0-9]{1,2}(?:\.\d+)?)\s*\|\s*([^|]*)\|\s*([^|]*)\|/g;

  for (const m of kokaiBlock.matchAll(kokaiRowRe)) {
    const n = Number(m[1]);
    const date = parseYmdLoose(m[2]);

    const fourScore = clampNum(toNumberOrNull(m[3]), 0, 500);
    const fourDev = clampNum(toNumberOrNull(m[4]), 10, 90);

    // 2科は空欄のことが多いので、空欄ならnull
    const twoScore = clampNum(toNumberOrNull(m[5]), 0, 400);
    const twoDev = clampNum(toNumberOrNull(m[6]), 10, 90);

    const t: any = {
      testType: "kokai_moshi",
      testName: `第${n}回公開模試`,
      date,
      subjects: [],
      totals: {
        two: { score: twoScore, deviation: twoDev, rank: null, avg: null, diffFromAvg: null, grade: null },
        four: { score: fourScore, deviation: fourDev, rank: null, avg: null, diffFromAvg: null, grade: null },
      },
      notes: [],
    };

    nullifyFieldsByType(t);
    forceNullifyFourIfMissing(t);

    yearly.tests.push(t);
  }

  // 学判やその他が混じっていない前提だが、念のため再フィルタ
  yearly.tests = yearly.tests.filter((t) => t.testType === "ikusei" || t.testType === "kokai_moshi");

  // ざっくり並び：日付が取れたものを優先して昇順
  yearly.tests.sort((a, b) => {
    const da = a.date ?? "";
    const db = b.date ?? "";
    if (da && db) return da.localeCompare(db);
    if (da && !db) return -1;
    if (!da && db) return 1;
    return String(a.testName ?? "").localeCompare(String(b.testName ?? ""));
  });

  return yearly;
}

/* =========================
   Direct extraction from PDF（残しておく：保険）
========================= */
async function extractJukuReportJsonDirectFromPdf(params: {
  bucket: string;
  path: string;
  filename: string;
  mode: "yearly" | "single";
}): Promise<{ ok: boolean; reportJson: JukuReportJson | null; raw: string; error: string | null }> {
  const { bucket, path, filename, mode } = params;

  const { data: pdfBlob, error } = await supabase.storage.from(bucket).download(path);
  if (error || !pdfBlob) throw new Error(`Supabase download failed: ${error?.message}`);

  const ab = await pdfBlob.arrayBuffer();
  const buf = Buffer.from(ab);

  const uploaded = await openai.files.create({
    file: await OpenAI.toFile(buf, filename, { type: "application/pdf" }),
    purpose: "assistants",
  });

  try {
    const system =
      mode === "yearly"
        ? `
あなたは塾の「成績推移表」からデータ抽出します。
抽出対象：育成（得点/評価）、公開（得点/偏差）
禁止：推測、2科→4科コピー、学判、平均点/平均との差の生成
返答は必ずJSONのみ。
`.trim()
        : `
あなたは塾の「単発の成績表」からデータ抽出します。
育成/公開のみ。推測禁止。返答はJSONのみ。
`.trim();

    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "input_file", file_id: uploaded.id },
            { type: "input_text", text: `ファイル名: ${filename}\n指定スキーマに沿ってJSON化。空欄はnull。` },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: JUKU_REPORT_JSON_SCHEMA.name,
          schema: (JUKU_REPORT_JSON_SCHEMA as any).schema,
          strict: (JUKU_REPORT_JSON_SCHEMA as any).strict,
        },
      } as any,
    });

    const out = typeof resp.output_text === "string" ? resp.output_text.trim() : "";
    const parsed = safeParseJson<JukuReportJson>(out);

    if (!parsed || parsed.docType !== "juku_report") {
      return { ok: false, reportJson: null, raw: out, error: "JSON parse failed or invalid docType" };
    }

    parsed.tests = Array.isArray(parsed.tests) ? parsed.tests : [];
    parsed.tests = parsed.tests
      .map((t: any) => {
        const nm = String(t?.testName ?? t?.testType ?? "");
        const tt = normalizeTestTypeLabel(nm);
        return { ...t, testType: tt };
      })
      .filter((t: any) => !isGakuhanLike(String(t?.testName ?? "")));

    parsed.tests = parsed.tests.filter((t: any) => t.testType === "ikusei" || t.testType === "kokai_moshi");

    for (const t of parsed.tests ?? []) {
      t.totals = t.totals ?? {
        two: { score: null, deviation: null, rank: null, avg: null, diffFromAvg: null, grade: null },
        four: { score: null, deviation: null, rank: null, avg: null, diffFromAvg: null, grade: null },
      };

      // 軽い整形
      t.totals.two.score = clampNum(t.totals.two.score, 0, 400);
      t.totals.four.score = clampNum(t.totals.four.score, 0, 500);
      t.totals.two.deviation = clampNum(t.totals.two.deviation, 10, 90);
      t.totals.four.deviation = clampNum(t.totals.four.deviation, 10, 90);
      t.totals.two.grade = clampNum(t.totals.two.grade, 0, 10);
      t.totals.four.grade = clampNum(t.totals.four.grade, 0, 10);

      nullifyFieldsByType(t);
      forceNullifyFourIfMissing(t);
    }

    return { ok: true, reportJson: parsed, raw: out, error: null };
  } catch (e: any) {
    return { ok: false, reportJson: null, raw: "", error: e?.message ?? "extract error" };
  } finally {
    try {
      await openai.files.delete(uploaded.id);
    } catch {}
  }
}

/* =========================
   Trends
========================= */
type Trend = "up" | "down" | "flat" | "unknown";

function judgeTrend(vals: number[], threshold: number): Trend {
  if (!vals || vals.length < 2) return "unknown";
  const first = vals[0];
  const last = vals[vals.length - 1];
  if (!Number.isFinite(first) || !Number.isFinite(last)) return "unknown";
  const diff = last - first;
  if (diff >= threshold) return "up";
  if (diff <= -threshold) return "down";
  return "flat";
}

function extractYearlyTrends(yearly: JukuReportJson | null) {
  if (!yearly) {
    return {
      ikusei: { trend: "unknown" as Trend, values: [] as number[] },
      kokai: { trend: "unknown" as Trend, values: [] as number[] },
    };
  }

  const tests = yearly.tests ?? [];

  const ikuseiVals: number[] = tests
    .filter((t) => t.testType === "ikusei")
    .map((t: any) => (typeof t?.totals?.two?.grade === "number" ? t.totals.two.grade : null))
    .filter((v: any) => typeof v === "number" && Number.isFinite(v));

  const kokaiVals: number[] = tests
    .filter((t) => t.testType === "kokai_moshi")
    .map((t: any) => (typeof t?.totals?.four?.deviation === "number" ? t.totals.four.deviation : t?.totals?.two?.deviation))
    .filter((v: any) => typeof v === "number" && Number.isFinite(v));

  return {
    ikusei: { trend: judgeTrend(ikuseiVals, 1), values: ikuseiVals },
    kokai: { trend: judgeTrend(kokaiVals, 3), values: kokaiVals },
  };
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

    // yearly
    let yearlyOcrText: string | null = null;
    let yearlyOcrError: string | null = null;

    let yearlyReportJson: any | null = null;
    let yearlyReportJsonMeta: { ok: boolean; error: string | null } | null = null;
    let yearlyDebug: any | null = null;

    if (uploadedYearly) {
      // OCR（このテキストから“確実に”行を抽出する）
      try {
        yearlyOcrText = await ocrPdfFromStorage({
          bucket,
          path: uploadedYearly.path,
          filename: uploadedYearly.name,
        });
      } catch (e: any) {
        yearlyOcrText = null;
        yearlyOcrError = e?.message ?? "yearly OCR error";
        console.error("[yearly OCR error]", uploadedYearly?.name, e);
      }

      // ★優先：OCRテキストから機械的に抽出（取りこぼし防止）
      if (yearlyOcrText) {
        yearlyReportJson = buildYearlyFromOcrText(yearlyOcrText, uploadedYearly.name);
        yearlyReportJsonMeta = { ok: true, error: null };
        yearlyDebug = {
          mode: "yearly-ocr-regex",
          ocrLen: yearlyOcrText.length,
          extractedTests: yearlyReportJson.tests?.length ?? 0,
        };
      } else {
        // 保険：direct抽出（OCR取れない等の場合）
        const extractedYearly = await extractJukuReportJsonDirectFromPdf({
          bucket,
          path: uploadedYearly.path,
          filename: uploadedYearly.name,
          mode: "yearly",
        });

        yearlyReportJson = extractedYearly.reportJson;
        yearlyReportJsonMeta = {
          ok: extractedYearly.ok,
          error: extractedYearly.ok ? null : extractedYearly.error ?? "JSON化に失敗",
        };
        yearlyDebug = { mode: "yearly-direct", rawLen: extractedYearly.raw?.length ?? 0 };
      }
    }

    const trends = extractYearlyTrends(yearlyReportJson as any);

    return NextResponse.json({
      summary: `単発=${uploadedSingles.length}枚 / 年間=${uploadedYearly ? "あり" : "なし"}`,
      files: { singles: uploadedSingles, yearly: uploadedYearly },
      ocr: {
        singles: [],
        yearly: yearlyOcrText,
        yearlyError: yearlyOcrError,
        yearlyReportJson,
        yearlyReportJsonMeta,
        yearlyDebug,
      },
      assumedAverage: ASSUMED_AVERAGE,
      yearlyTrends: trends,
      commentary:
        uploadedSingles.length === 0
          ? "単発PDFが未投入です。メイン分析は単発（育成/公開の1回分）を入れると精度が上がります。年間は推移の補助として扱います。"
          : "単発PDFを元に分析します。",
    });
  } catch (e: any) {
    console.error("[route POST fatal]", e);
    return new NextResponse(e?.message ?? "Server error", { status: 500 });
  }
}
