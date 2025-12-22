/// <reference types="node" />
import { Buffer } from "buffer";
import { randomUUID } from "crypto";
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
   Types
========================= */
type Trend = "up" | "down" | "flat" | "unknown";

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
    }>;
    totals: {
      two: {
        score: number | null;
        deviation: number | null;
        rank: number | null;
        grade: number | null;
      };
      four: {
        score: number | null;
        deviation: number | null;
        rank: number | null;
        grade: number | null;
      };
    };
    notes: string[];
  }>;
  notes: string[];
};

type YearlyFormat = "auto" | "A" | "B";

/**
 * ✅ Schemaエラー回避：docTypeにtype必須
 * ※ tests の詳細はここでは縛らず、抽出後に整形する方針
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
      // ✅ 修正：items を入れて Schema エラー回避
      tests: { type: "array", items: { type: "object" } },
      notes: { type: "array", items: { type: "string" } },
    },
    required: ["docType", "student", "meta", "tests", "notes"],
  },
  strict: true,
} as const;

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
  if (/(公開模試|公開模擬試験|公開模試成績|公開|Public模試成績|Public模試)/i.test(t))
    return "kokai_moshi";
  return "other";
}

function isGakuhanLike(s: string) {
  const t = String(s ?? "").replace(/\s+/g, "");
  return /(学判|学力判定|学力診断|学力到達度|到達度テスト)/.test(t);
}

/**
 * 日付：
 * - YYYY/M/D → YYYY-MM-DD
 * - YYYY/M   → YYYY-MM-01
 * - YYYY     → YYYY-01-01（年だけでも落とさない）
 *
 * ✅重要：精度優先で「具体日付→年月→年のみ」の順に判定する
 */
function parseYmdOrYmLoose(s: string): string | null {
  const t = String(s ?? "").trim();

  // YYYY/M/D or YYYY-M-D etc
  const m1 = t.match(/(20\d{2})\s*[\/\-\.\s]\s*(\d{1,2})\s*[\/\-\.\s]\s*(\d{1,2})/);
  if (m1) {
    const yy = Number(m1[1]);
    const mm = Number(m1[2]);
    const dd = Number(m1[3]);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return `${String(yy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
  }

  // YYYY/M（年月のみ）→ day=01
  const m2 = t.match(/(20\d{2})\s*[\/\-\.\s]\s*(\d{1,2})\b/);
  if (m2) {
    const yy = Number(m2[1]);
    const mm = Number(m2[2]);
    if (mm >= 1 && mm <= 12) {
      return `${String(yy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-01`;
    }
  }

  // YYYY only（最後の保険）
  const m0 = t.match(/\b(20\d{2})\b/);
  if (m0) {
    const yy = Number(m0[1]);
    return `${String(yy).padStart(4, "0")}-01-01`;
  }

  return null;
}

function sliceBetweenAny(text: string, starts: RegExp[], ends: RegExp[]) {
  let startPos = -1;
  for (const st of starts) {
    const p = text.search(st);
    if (p >= 0 && (startPos < 0 || p < startPos)) startPos = p;
  }
  if (startPos < 0) return "";

  const sub = text.slice(startPos);

  let endPos = -1;
  for (const ed of ends) {
    const p = sub.search(ed);
    if (p >= 0 && (endPos < 0 || p < endPos)) endPos = p;
  }
  if (endPos < 0) return sub;

  return sub.slice(0, endPos);
}

/* =========================
   Guards / Normalization
========================= */
function nullifyFieldsByType(t: any) {
  // 育成：score + grade（偏差は使わない）
  if (t.testType === "ikusei") {
    if (t?.totals?.two) t.totals.two.deviation = null;
    if (t?.totals?.four) t.totals.four.deviation = null;
  }

  // 公開：score + deviation（gradeは使わない）
  if (t.testType === "kokai_moshi") {
    if (t?.totals?.two) t.totals.two.grade = null;
    if (t?.totals?.four) t.totals.four.grade = null;
  }
}

function forceNullifyFourIfMissing(t: any) {
  if (!t?.totals?.four) return;
  const fourScore = toNumberOrNull(t.totals.four.score);
  const fourDev = toNumberOrNull(t.totals.four.deviation);
  const fourGrade = toNumberOrNull(t.totals.four.grade);
  if (fourScore == null && fourDev == null && fourGrade == null) {
    t.totals.four = { score: null, deviation: null, rank: null, grade: null };
  }
}

/**
 * 育成の2科/4科が混ざった時の最低限の安全弁（誤爆しにくい強条件）
 */
function fixIkuseiTwoFourMix(t: any) {
  if (!t || t.testType !== "ikusei") return;
  if (!t.totals?.two || !t.totals?.four) return;

  const twoScore = toNumberOrNull(t.totals.two.score);
  const fourScore = toNumberOrNull(t.totals.four.score);
  const twoGrade = toNumberOrNull(t.totals.two.grade);
  const fourGrade = toNumberOrNull(t.totals.four.grade);

  if (twoScore == null && fourScore == null) return;

  // 4科が小さすぎ、2科が大きすぎ → 入れ替わりの可能性が高い
  if (fourScore != null && twoScore != null) {
    const fourTooSmall = fourScore <= 170;
    const twoTooBig = twoScore >= 220;
    if (fourTooSmall && twoTooBig) {
      t.totals.two.score = fourScore;
      t.totals.four.score = twoScore;

      // 評価も入れ替え（存在するものだけ）
      t.totals.two.grade = fourGrade ?? t.totals.two.grade ?? null;
      t.totals.four.grade = twoGrade ?? t.totals.four.grade ?? null;
      return;
    }
  }

  // 4科が異常に小さく、2科も無い/小さい → 4科は空欄扱い
  if (fourScore != null && fourScore <= 120 && (twoScore == null || twoScore <= 120)) {
    t.totals.four.score = null;
    t.totals.four.grade = null;
    t.totals.four.deviation = null;
  }
}

// ✅ 公開：4科得点が「日付断片/桁落ち」っぽいときは null
function fixKokaiFourScoreIfSuspicious(t: any) {
  if (!t || t.testType !== "kokai_moshi") return;

  const fourScore = toNumberOrNull(t?.totals?.four?.score);
  const fourDev = toNumberOrNull(t?.totals?.four?.deviation);

  if (fourScore != null && fourScore > 0 && fourScore <= 20) {
    t.totals.four.score = null;
    t.totals.four.deviation = null;
  }

  void fourDev;
}

/* =========================
   Format Detection
========================= */
function detectYearlyFormatFromOcrText(text: string): YearlyFormat {
  const t = String(text ?? "");

  // 5年寄り（B）
  if (/Public模試成績/i.test(t)) return "B";
  if (/年間学習力育成テスト/i.test(t)) return "B";
  if (/(Ⅲ|III)\s*[\.．]\s*年間学習力育成テスト/i.test(t)) return "B";

  // 6年寄り（A）
  if (/(V|Ⅴ)\s*[\.．]\s*公開模試成績/i.test(t)) return "A";
  if (/(Ⅲ|III)\s*[\.．]\s*(前期|前年)学習力育成テスト/i.test(t)) return "A";

  if (/公開模試成績|公開模試|育成テスト/.test(t)) return "A";

  return "auto";
}

/* =========================
   OCR (PDF -> text)
========================= */
async function ocrPdfFromStorage(params: {
  bucket: string;
  path: string;
  filename: string;
  focusHint?: string;
}) {
  const { bucket, path, filename, focusHint } = params;

  const { data: pdfBlob, error } = await supabase.storage.from(bucket).download(path);
  if (error || !pdfBlob) throw new Error(`Supabase download failed: ${error?.message}`);

  const ab = await pdfBlob.arrayBuffer();
  const buf = Buffer.from(ab);

  const uploaded = await openai.files.create({
    file: await OpenAI.toFile(buf, filename, { type: "application/pdf" }),
    purpose: "assistants",
  });

  try {
    const base =
      "PDFをページ番号付きでOCR転記してください。要約禁止。推測禁止。省略禁止。表は可能な限り表形式で。";

    const focus = focusHint
      ? `\n\n【重要】今回は次の内容が載っている箇所だけを優先して転記して：\n${focusHint}\n（それ以外は省略してOK）`
      : "";

    const resp = await openai.responses.create({
      model: leadingModelName(),
      input: [
        {
          role: "user",
          content: [
            { type: "input_file", file_id: uploaded.id },
            { type: "input_text", text: base + focus },
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
   Build yearly JSON from OCR text (format aware)
========================= */
function buildYearlyFromOcrTextByFormat(
  ocrText: string,
  sourceFilename: string,
  format: Exclude<YearlyFormat, "auto">
) {
  const yearly: JukuReportJson = {
    docType: "juku_report",
    student: { name: null, id: null },
    meta: { sourceFilename, title: null },
    tests: [],
    notes: [],
  };

  // ===== 育成ブロック =====
  const ikuseiStarts =
    format === "A"
      ? [
          /(III|Ⅲ)\s*[\.．]\s*(前期|前年)学習力育成テスト出題範囲及び成績/i,
          /(III|Ⅲ)\s*[\.．]\s*(前期|前年)学習力育成テスト/i,
        ]
      : [
          /(III|Ⅲ)\s*[\.．]\s*年間学習力育成テスト出題範囲及び成績/i,
          /(III|Ⅲ)\s*[\.．]\s*年間学習力育成テスト/i,
        ];

  const ikuseiEnds = [
    /思考力育成テスト/i,
    /合格力実践テスト/i,
    /(IV|Ⅳ)\s*[\.．]/i,
    /(V|Ⅴ)\s*[\.．]/i,
    /公開模試/i,
    /Public模試/i,
  ];

  const ikuseiBlock = sliceBetweenAny(ocrText, ikuseiStarts, ikuseiEnds);

  // | 回 | 日付 | 4科得点 | 評価 | 2科得点 | 評価 | ・・・（右に列が続いてもOK）
  const ikuseiRowRe =
    /\|\s*(\d{1,2})\s*\|\s*([^\|]{3,24})\|\s*([0-9]{1,3})\s*\|\s*([0-9]{1,2}(?:\.\d+)?)\s*\|\s*([0-9]{1,3})\s*\|\s*([0-9]{1,2}(?:\.\d+)?)\s*\|[^\r\n]*(?:\r?\n|$)/g;

  for (const m of ikuseiBlock.matchAll(ikuseiRowRe)) {
    const n = Number(m[1]);
    const date = parseYmdOrYmLoose(m[2]);
    if (!date) continue;

    const fourScore = clampNum(toNumberOrNull(m[3]), 0, 500);

    // ✅修正：育成の評価は 3〜10 のみ
    const fourGrade = clampNum(toNumberOrNull(m[4]), 3, 10);

    const twoScore = clampNum(toNumberOrNull(m[5]), 0, 400);

    // ✅修正：育成の評価は 3〜10 のみ
    const twoGrade = clampNum(toNumberOrNull(m[6]), 3, 10);

    const t: any = {
      testType: "ikusei",
      testName: `第${n}回育成テスト`,
      date,
      subjects: [],
      totals: {
        two: { score: twoScore, deviation: null, rank: null, grade: twoGrade },
        four: { score: fourScore, deviation: null, rank: null, grade: fourGrade },
      },
      notes: [],
    };

    nullifyFieldsByType(t);
    forceNullifyFourIfMissing(t);
    fixIkuseiTwoFourMix(t);

    yearly.tests.push(t);
  }

  // ===== 公開ブロック =====
  const kokaiStarts =
    format === "A"
      ? [/(V|Ⅴ)\s*[\.．]\s*公開模試成績/i, /公開模試成績/i]
      : [/Public模試成績/i, /公開模試成績/i, /(V|Ⅴ)\s*[\.．]\s*公開模試成績/i];

  // ✅ /---$/m で区切り線に誤爆して表の前で切れるのを避ける
  const kokaiEnds = [
    /春期/i,
    /夏期/i,
    /冬期/i,
    /合格力育成テスト/i,
    /合格力実践テスト/i,
    /転記終了/i,
    /必要に応じて他の部分も転記/i,
  ];

  const kokaiBlock = sliceBetweenAny(ocrText, kokaiStarts, kokaiEnds);

  // 分割日付版（| 回 | 年 | 月 | 日 | 4科得点 | 偏差 | 2科得点 | 偏差 |）
  const kokaiRowReSplit =
    /\|\s*(\d{1,2})\s*\|\s*(20\d{2})\s*\|\s*(\d{1,2})\s*\|\s*(\d{1,2})\s*\|\s*([0-9]{1,3})\s*\|\s*([0-9]{1,2}(?:\.\d+)?)\s*\|\s*([^|]*)\|\s*([^|]*)\|/g;

  // 単一セル日付版（| 回 | 日付 | 4科得点 | 偏差 | 2科得点 | 偏差 |）
  const kokaiRowRe =
    /\|\s*(\d{1,2})\s*\|\s*([^\|]{3,24})\|\s*([0-9]{1,3})\s*\|\s*([0-9]{1,2}(?:\.\d+)?)\s*\|\s*([^|]*)\|\s*([^|]*)\|/g;

  let matchedAnyKokai = false;

  for (const m of kokaiBlock.matchAll(kokaiRowReSplit)) {
    matchedAnyKokai = true;

    const n = Number(m[1]);
    const yy = Number(m[2]);
    const mm = Number(m[3]);
    const dd = Number(m[4]);

    const date =
      mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31
        ? `${String(yy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`
        : null;
    if (!date) continue;

    const fourScore = clampNum(toNumberOrNull(m[5]), 0, 500);
    const fourDev = clampNum(toNumberOrNull(m[6]), 10, 90);

    const twoScore = clampNum(toNumberOrNull(m[7]), 0, 400);
    const twoDev = clampNum(toNumberOrNull(m[8]), 10, 90);

    const t: any = {
      testType: "kokai_moshi",
      testName: `第${n}回公開模試`,
      date,
      subjects: [],
      totals: {
        two: { score: twoScore, deviation: twoDev, rank: null, grade: null },
        four: { score: fourScore, deviation: fourDev, rank: null, grade: null },
      },
      notes: [],
    };

    nullifyFieldsByType(t);
    forceNullifyFourIfMissing(t);
    fixKokaiFourScoreIfSuspicious(t);

    yearly.tests.push(t);
  }

  if (!matchedAnyKokai) {
    for (const m of kokaiBlock.matchAll(kokaiRowRe)) {
      const n = Number(m[1]);
      const date = parseYmdOrYmLoose(m[2]);
      if (!date) continue;

      const fourScore = clampNum(toNumberOrNull(m[3]), 0, 500);
      const fourDev = clampNum(toNumberOrNull(m[4]), 10, 90);

      const twoScore = clampNum(toNumberOrNull(m[5]), 0, 400);
      const twoDev = clampNum(toNumberOrNull(m[6]), 10, 90);

      const t: any = {
        testType: "kokai_moshi",
        testName: `第${n}回公開模試`,
        date,
        subjects: [],
        totals: {
          two: { score: twoScore, deviation: twoDev, rank: null, grade: null },
          four: { score: fourScore, deviation: fourDev, rank: null, grade: null },
        },
        notes: [],
      };

      nullifyFieldsByType(t);
      forceNullifyFourIfMissing(t);
      fixKokaiFourScoreIfSuspicious(t);

      yearly.tests.push(t);
    }
  }

  // 念のため：育成/公開のみ + 学判除外
  yearly.tests = yearly.tests
    .map((t: any) => {
      const nm = String(t?.testName ?? "");
      const tt = normalizeTestTypeLabel(nm);
      return { ...t, testType: tt };
    })
    .filter(
      (t: any) =>
        (t.testType === "ikusei" || t.testType === "kokai_moshi") &&
        !isGakuhanLike(String(t?.testName ?? ""))
    );

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

function buildYearlyFromOcrTextAuto(ocrText: string, sourceFilename: string) {
  const detected = detectYearlyFormatFromOcrText(ocrText);

  const a = buildYearlyFromOcrTextByFormat(ocrText, sourceFilename, "A");
  const b = buildYearlyFromOcrTextByFormat(ocrText, sourceFilename, "B");

  const aCount = a.tests?.length ?? 0;
  const bCount = b.tests?.length ?? 0;

  let best: JukuReportJson;
  let chosen: Exclude<YearlyFormat, "auto">;

  if (aCount > bCount) {
    best = a;
    chosen = "A";
  } else if (bCount > aCount) {
    best = b;
    chosen = "B";
  } else {
    if (detected === "B") {
      best = b;
      chosen = "B";
    } else {
      best = a;
      chosen = "A";
    }
  }

  return { yearly: best, detected, chosen, aCount, bCount };
}

/* =========================
   Direct extraction (保険)
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
      model: leadingModelName(),
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
        two: { score: null, deviation: null, rank: null, grade: null },
        four: { score: null, deviation: null, rank: null, grade: null },
      };

      t.totals.two.score = clampNum(t.totals.two.score, 0, 400);
      t.totals.four.score = clampNum(t.totals.four.score, 0, 500);
      t.totals.two.deviation = clampNum(t.totals.two.deviation, 10, 90);
      t.totals.four.deviation = clampNum(t.totals.four.deviation, 10, 90);

      // ✅ 修正：育成の評価だけ 3〜10
      if (t.testType === "ikusei") {
        t.totals.two.grade = clampNum(t.totals.two.grade, 3, 10);
        t.totals.four.grade = clampNum(t.totals.four.grade, 3, 10);
      } else {
        t.totals.two.grade = clampNum(t.totals.two.grade, 0, 10);
        t.totals.four.grade = clampNum(t.totals.four.grade, 0, 10);
      }

      nullifyFieldsByType(t);
      forceNullifyFourIfMissing(t);
      fixIkuseiTwoFourMix(t);
      fixKokaiFourScoreIfSuspicious(t);
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

  // 育成：評価（2科評価を優先）
  const ikuseiVals: number[] = tests
    .filter((t) => t.testType === "ikusei")
    .map((t: any) => (typeof t?.totals?.two?.grade === "number" ? t.totals.two.grade : null))
    .filter((v: any) => typeof v === "number" && Number.isFinite(v));

  // 公開：偏差（4科偏差優先、無ければ2科）
  const kokaiVals: number[] = tests
    .filter((t) => t.testType === "kokai_moshi")
    .map((t: any) =>
      typeof t?.totals?.four?.deviation === "number"
        ? t.totals.four.deviation
        : typeof t?.totals?.two?.deviation === "number"
          ? t.totals.two.deviation
          : null
    )
    .filter((v: any) => typeof v === "number" && Number.isFinite(v));

  return {
    ikusei: { trend: judgeTrend(ikuseiVals, 1), values: ikuseiVals },
    kokai: { trend: judgeTrend(kokaiVals, 3), values: kokaiVals },
  };
}

/* =========================
   Model helper
========================= */
function leadingModelName() {
  return "gpt-4.1-mini";
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

    const yearlyFormatRaw = fd.get("yearlyFormat");
    const yearlyFormat: YearlyFormat =
      yearlyFormatRaw === "A" || yearlyFormatRaw === "B" || yearlyFormatRaw === "auto"
        ? (yearlyFormatRaw as any)
        : "auto";

    if (singleFiles.length === 0 && !yearlyFile) {
      return new NextResponse("PDFがありません。", { status: 400 });
    }

    const bucket = process.env.SUPABASE_PDF_BUCKET ?? "report-pdfs";
    const baseDir = `analyze/${randomUUID()}`;

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

    let yearlyOcrText: string | null = null;
    let yearlyOcrError: string | null = null;

    let yearlyReportJson: any | null = null;
    let yearlyReportJsonMeta: { ok: boolean; error: string | null } | null = null;
    let yearlyDebug: any | null = null;

    if (uploadedYearly) {
      try {
        const yearlyOcrTextIkusei = await ocrPdfFromStorage({
          bucket,
          path: uploadedYearly.path,
          filename: uploadedYearly.name,
          focusHint:
            "III. 前期/前年 学習力育成テスト 出題範囲及び成績（回数・試験実施日・4科目得点・評価・2科目得点・評価の表）",
        });

        const yearlyOcrTextKokai = await ocrPdfFromStorage({
          bucket,
          path: uploadedYearly.path,
          filename: uploadedYearly.name,
          focusHint:
            "V. 公開模試成績（回数・年/月/日・4科得点・偏差・2科得点・偏差の表）",
        });

        yearlyOcrText = [yearlyOcrTextIkusei, yearlyOcrTextKokai].filter(Boolean).join("\n\n---\n\n");
      } catch (e: any) {
        yearlyOcrText = null;
        yearlyOcrError = e?.message ?? "yearly OCR error";
        console.error("[yearly OCR error]", uploadedYearly?.name, e);
      }

      if (yearlyOcrText) {
        if (yearlyFormat === "A" || yearlyFormat === "B") {
          yearlyReportJson = buildYearlyFromOcrTextByFormat(yearlyOcrText, uploadedYearly.name, yearlyFormat);
          yearlyReportJsonMeta = { ok: true, error: null };
          yearlyDebug = {
            mode: "yearly-ocr-regex",
            forcedFormat: yearlyFormat,
            ocrLen: yearlyOcrText.length,
            extractedTests: yearlyReportJson.tests?.length ?? 0,
          };
        } else {
          const auto = buildYearlyFromOcrTextAuto(yearlyOcrText, uploadedYearly.name);
          yearlyReportJson = auto.yearly;
          yearlyReportJsonMeta = { ok: true, error: null };
          yearlyDebug = {
            mode: "yearly-ocr-regex",
            detectedFormat: auto.detected,
            chosenFormat: auto.chosen,
            tryA: auto.aCount,
            tryB: auto.bCount,
            ocrLen: yearlyOcrText.length,
            extractedTests: yearlyReportJson.tests?.length ?? 0,
          };
        }
      } else {
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
