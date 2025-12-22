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
 * ✅ ここが重要：docType に type を必ず入れる
 * constだけだと 400 Invalid schema になります
 */
const JUKU_REPORT_JSON_SCHEMA = {
  name: "juku_report_json",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      docType: { type: "string", const: "juku_report" }, // ✅ type必須
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
            testType: { type: "string" },
            testName: { type: ["string", "null"] },
            date: { type: ["string", "null"] },
            subjects: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: { type: ["string", "null"] },
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
    }
    if (t?.totals?.four) {
      t.totals.four.avg = null;
      t.totals.four.diffFromAvg = null;
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

function forceNullifyFourIfSubjectsEmpty(t: any) {
  const subjectsEmpty = !Array.isArray(t?.subjects) || t.subjects.length === 0;
  if (!subjectsEmpty) return;

  if (!t?.totals?.four) return;
  t.totals.four = {
    score: null,
    deviation: null,
    rank: null,
    avg: null,
    diffFromAvg: null,
    grade: null,
  };
}

/* =========================
   OCR（PDFを input_file で渡す：これが必須）
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
            { type: "input_file", file_id: uploaded.id }, // ✅ ここが無いと「PDF受け取れません」になる
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
   Direct extraction（PDFを input_file で渡す：これも必須）
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

【抽出対象（必須）】
- 育成テスト：回ごとの「得点」「評価（10〜3）」
- 公開模試：回ごとの「得点」「偏差」

【禁止】
- 空欄を推測で埋めない
- 2科の値を4科にコピーしない
- 学判（学力判定等）は抽出しない
- 平均点/平均との差が載っていない場合は作らない
`
        : `
あなたは塾の「単発の成績表」からデータ抽出します。
育成/公開のみ。推測禁止。
`;

    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: system.trim() },
        {
          role: "user",
          content: [
            { type: "input_file", file_id: uploaded.id }, // ✅ 必須
            {
              type: "input_text",
              text: `ファイル名: ${filename}\nこのPDFから育成/公開の回ごとの推移をJSON化してください。空欄はnull。`,
            },
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

    // type整形（公開/育成優先、学判排除）
    parsed.tests = Array.isArray(parsed.tests) ? parsed.tests : [];
    parsed.tests = parsed.tests
      .map((t: any) => {
        const nm = String(t?.testName ?? t?.testType ?? "");
        const tt = normalizeTestTypeLabel(nm);
        return { ...t, testType: tt };
      })
      .filter((t: any) => !isGakuhanLike(String(t?.testName ?? "")));

    // 使うのは育成/公開のみ
    parsed.tests = parsed.tests.filter((t: any) => t.testType === "ikusei" || t.testType === "kokai_moshi");

    // 数値レンジ軽く整形（過剰なnullはOK）
    for (const t of parsed.tests ?? []) {
      t.subjects = Array.isArray(t.subjects) ? t.subjects : [];
      t.totals = t.totals ?? {
        two: { score: null, deviation: null, rank: null, avg: null, diffFromAvg: null, grade: null },
        four: { score: null, deviation: null, rank: null, avg: null, diffFromAvg: null, grade: null },
      };
      t.totals.two.score = clampNum(t.totals.two.score, 0, 400);
      t.totals.four.score = clampNum(t.totals.four.score, 0, 500);
      t.totals.two.deviation = clampNum(t.totals.two.deviation, 10, 90);
      t.totals.four.deviation = clampNum(t.totals.four.deviation, 10, 90);
      t.totals.two.grade = clampNum(t.totals.two.grade, 0, 10);
      t.totals.four.grade = clampNum(t.totals.four.grade, 0, 10);

      // ★安全弁
      nullifyFieldsByType(t);
      forceNullifyFourIfSubjectsEmpty(t);
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
    .map((t: any) => t?.totals?.two?.grade)
    .filter((v: any) => typeof v === "number" && Number.isFinite(v));

  const kokaiVals: number[] = tests
    .filter((t) => t.testType === "kokai_moshi")
    .map((t: any) => t?.totals?.two?.deviation)
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
      // OCR（参考）
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

      // direct抽出（本命）
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
