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

/** Supabase Storage 上のPDFをOCR */
async function ocrPdfFromStorage(params: {
  bucket: string;
  path: string;
  filename: string;
}) {
  const { bucket, path, filename } = params;

  // 1) PDF download
  const { data: pdfBlob, error } = await supabase.storage
    .from(bucket)
    .download(path);

  if (error || !pdfBlob) {
    throw new Error(`Supabase download failed: ${error?.message}`);
  }

  // 2) OpenAI Files にアップロード
  const ab = await pdfBlob.arrayBuffer();
  const buf = Buffer.from(ab);

  const uploaded = await openai.files.create({
    file: await OpenAI.toFile(buf, filename, { type: "application/pdf" }),
    purpose: "assistants",
  });

  // 3) OCR（Responses API）
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

  // 4) OpenAI側のファイルを掃除（SDKでは delete）
  try {
    await openai.files.delete(uploaded.id);
  } catch {
    // 削除失敗しても致命的ではないので無視
  }

  return typeof resp.output_text === "string" ? resp.output_text : "";
}

/* =========================
   JSON schema（抽出）
========================= */

/**
 * 受験塾（育成テスト / 公開模試）用の成績JSON
 * - 学校の期末テスト等は扱わない
 * - 「偏差値」または「偏差」のどちらでも deviation に入れる
 * - 2科/4科（合計や偏差、順位、平均との差）も totals に入れる
 */
type JukuReportJson = {
  docType: "juku_report";
  student: { name: string | null; id: string | null };
  meta: {
    sourceFilename: string | null;
    // 学習相談など帳票タイトルが取れれば入れる
    title: string | null;
  };
  tests: Array<{
    testType: "ikusei" | "kokai_moshi" | "other";
    testName: string | null; // 例：第◯回育成テスト / 公開模試 / etc.
    date: string | null;
    subjects: Array<{
      name: "国語" | "算数" | "理科" | "社会" | "不明";
      score: number | null;
      deviation: number | null; // 偏差値 or 偏差
      rank: number | null;
      avg: number | null; // 平均点
      diffFromAvg: number | null; // 平均差（あれば）
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

/* =========================
   ★ JSON Schema（text.format 用）
========================= */
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

/** OCRテキストから受験塾用成績JSONを抽出（育成テスト/公開模試） */
async function extractJukuReportJsonFromText(params: {
  filename: string;
  extractedText: string;
}) {
  const { filename, extractedText } = params;

  const head = extractedText.slice(0, 5000);
  const tail = extractedText.slice(-5000);
  const snippet = `${head}\n...\n${tail}`;

  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content:
          "あなたは中学受験塾の成績表データ化担当です。OCRテキストから『育成テスト』『公開模試』の成績を構造化JSONにします。" +
          "推測は禁止。見えない/不明はnull。空欄はnull。" +
          "【最重要】このアプリの対象は中学受験塾なので、学校の期末テスト/5科/9科/英語/音楽/体育などは原則として無視してください。" +
          "抽出対象は基本『国語・算数・理科・社会』と、2科/4科の合計・偏差(偏差値)・順位・平均点・平均との差です。" +
          "『偏差値』だけでなく『偏差』表記も deviation として扱ってください。" +
          "『育成テスト』『公開模試』という語があれば testType をそれぞれ ikusei / kokai_moshi にしてください。",
      },
      {
        role: "user",
        content:
          `ファイル名: ${filename}\n\n` +
          "次のOCRテキストから、受験塾（育成テスト/公開模試）の成績情報だけを抽出してください。\n" +
          "注意：学校の期末テスト等の数字が混在しても、それは抽出しない。\n\n" +
          "OCRテキスト:\n" +
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
    return {
      ok: false as const,
      reportJson: null as JukuReportJson | null,
      error: "JSONの解析に失敗（フォーマット不正）",
      raw: out,
    };
  }

  // 多少の正規化
  parsed.meta = parsed.meta ?? { sourceFilename: filename, title: null };
  if (parsed.meta.sourceFilename == null) parsed.meta.sourceFilename = filename;

  if (!Array.isArray(parsed.tests)) parsed.tests = [];
  parsed.tests = parsed.tests.map((t) => {
    if (!Array.isArray(t.subjects)) t.subjects = [];
    t.subjects = t.subjects
      .filter((s) => s && typeof s.name === "string" && s.name.trim().length > 0)
      .map((s) => ({
        name: (["国語", "算数", "理科", "社会"].includes(s.name)
          ? s.name
          : "不明") as any,
        score: typeof s.score === "number" ? s.score : null,
        deviation: typeof s.deviation === "number" ? s.deviation : null,
        rank: typeof s.rank === "number" ? s.rank : null,
        avg: typeof s.avg === "number" ? s.avg : null,
        diffFromAvg: typeof s.diffFromAvg === "number" ? s.diffFromAvg : null,
      }));

    // totalsの欠損を防ぐ
    t.totals = t.totals ?? {
      two: { score: null, deviation: null, rank: null, avg: null, diffFromAvg: null },
      four: { score: null, deviation: null, rank: null, avg: null, diffFromAvg: null },
    };
    t.totals.two = t.totals.two ?? {
      score: null, deviation: null, rank: null, avg: null, diffFromAvg: null,
    };
    t.totals.four = t.totals.four ?? {
      score: null, deviation: null, rank: null, avg: null, diffFromAvg: null,
    };

    if (!Array.isArray(t.notes)) t.notes = [];
    return t;
  });

  if (!Array.isArray(parsed.notes)) parsed.notes = [];

  return {
    ok: true as const,
    reportJson: parsed,
    raw: out,
  };
}

/* =========================
   成績表判定
========================= */
async function judgeGradeReport(params: {
  filename: string;
  extractedText: string;
}) {
  const { filename, extractedText } = params;

  const head = extractedText.slice(0, 3500);
  const tail = extractedText.slice(-3500);
  const snippet = `${head}\n...\n${tail}`;

  if (!snippet.trim()) {
    return {
      isGradeReport: false,
      confidence: 10,
      reason: "OCR結果がほぼ空でした（判定材料不足）",
    };
  }

  const NG_PATTERNS = [
    /入学試験|入試|選抜|試験問題|問題用紙|問題冊子/,
    /解答用紙|解答欄|解答用|解答用紙/,
    /配点|大問|小問|設問|注意事項/,
    /記入しないこと|記入しない|以下に記入|採点者/,
  ];

  const hasNg = NG_PATTERNS.some((re) => re.test(snippet));
  if (hasNg) {
    return {
      isGradeReport: false,
      confidence: 95,
      reason:
        "本文に「入試/問題用紙/解答用紙/配点/大問」等の語があり、成績表ではなく試験資料の可能性が高い",
    };
  }

  // ★受験塾の肯定根拠を強くする（育成テスト/公開模試）
  const POSITIVE_HINTS = [
    /育成テスト|学習力育成テスト/,
    /公開模試|公開模擬試験/,
    /偏差(値)?/, // 偏差値/偏差
    /順位/,
    /平均(点)?|平均との差/,
    /得点|点数/,
    /2科目|2科|4科目|4科/,
    /科目|国語|算数|理科|社会/,
  ];

  const posCount = POSITIVE_HINTS.reduce(
    (acc, re) => acc + (re.test(snippet) ? 1 : 0),
    0
  );

  // 受験塾帳票は「育成テスト/公開模試」が出ればほぼ成績表
  if (posCount < 1) {
    return {
      isGradeReport: false,
      confidence: 70,
      reason:
        "育成テスト/公開模試/偏差/順位/平均など成績表の根拠語が少なく、成績表の根拠が弱い",
    };
  }

  // LLM判定（補助）
  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content:
          "あなたは学習塾の業務システムで、PDFの内容が『受験塾の成績表（育成テスト/公開模試/偏差/順位/平均/2科4科など）』かどうかを判定する担当です。" +
          "根拠語を示して判定してください。",
      },
      {
        role: "user",
        content:
          "次のOCRテキストは、アップロードされたPDFの内容です。\n" +
          "ファイル名: " +
          filename +
          "\n\n" +
          "OCRテキスト（抜粋）:\n" +
          snippet +
          "\n\n" +
          "【重要】次のような文書は『成績表』ではありません：入学試験/入試/試験問題/問題用紙/解答用紙/解答欄/配点/大問小問/注意事項/『記入しないこと』\n" +
          "これらが本文に含まれる場合は isGradeReport=false にしてください。\n" +
          "受験塾の成績表の根拠は『育成テスト』『公開模試』『偏差/偏差値』『順位』『平均点/平均との差』『2科/4科』『国語/算数/理科/社会』などです。\n",
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
      confidence: Number.isFinite(obj.confidence)
        ? Math.max(0, Math.min(100, Number(obj.confidence)))
        : 50,
      reason:
        typeof obj.reason === "string" ? obj.reason : "理由の取得に失敗しました",
    };
  } catch {
    return {
      isGradeReport: false,
      confidence: 30,
      reason: "判定JSONの解析に失敗（フォーマット不正）",
    };
  }
}

/* =========================
   集計（analysis）
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
  const newAvg =
    a.avgDeviation === null ? dev : (a.avgDeviation * a.count + dev) / newCount;

  const newMin = a.minDeviation === null ? dev : Math.min(a.minDeviation, dev);

  return {
    ...a,
    count: newCount,
    avgDeviation: newAvg,
    lastDeviation: dev,
    minDeviation: newMin,
  };
}

// ★既存UI/集計の都合上、JukuReportJson → 旧来の subjects 配列の形へ寄せて集計するためのヘルパ
function flattenJukuReportToSubjectsForAnalysis(juku: JukuReportJson | null) {
  if (!juku) return [];

  // 全testsのsubjectsを合算（同名科目は複数回として扱う）
  const rows: Array<{ name: string; deviation: number | null }> = [];

  for (const t of juku.tests ?? []) {
    for (const s of t.subjects ?? []) {
      const nm = String(s?.name ?? "").trim();
      if (!nm) continue;
      rows.push({ name: nm, deviation: safeNum(s?.deviation) });
    }

    // 2科/4科も「2科」「4科」として集計に混ぜたい場合はここで追加
    // rows.push({ name: "2科", deviation: safeNum(t?.totals?.two?.deviation) });
    // rows.push({ name: "4科", deviation: safeNum(t?.totals?.four?.deviation) });
  }

  return rows;
}

function analyzeSinglesReportJson(
  singles: Array<{ reportJson?: any; filename?: string }>
) {
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
        ({
          name,
          count: 0,
          avgDeviation: null,
          lastDeviation: null,
          minDeviation: null,
        } as SubjectAgg);

      map.set(name, mergeAgg(cur, dev));
    }
  }

  const subjects = Array.from(map.values());

  subjects.sort((a, b) => {
    const av = a.avgDeviation ?? 9999;
    const bv = b.avgDeviation ?? 9999;
    return av - bv;
  });

  const weakest = subjects[0]?.avgDeviation != null ? subjects[0] : null;

  return { subjects, weakest };
}

function analyzeYearlyReportJson(yearly: any) {
  // ★ yearly が JukuReportJson の場合は flatten して集計
  if (yearly && yearly.docType === "juku_report") {
    const rows = flattenJukuReportToSubjectsForAnalysis(yearly as JukuReportJson);

    // rows から SubjectAgg を作る
    const map = new Map<string, SubjectAgg>();
    for (const row of rows) {
      const name = String(row.name ?? "").trim();
      if (!name) continue;

      const dev = safeNum(row.deviation);
      const cur =
        map.get(name) ??
        ({
          name,
          count: 0,
          avgDeviation: null,
          lastDeviation: null,
          minDeviation: null,
        } as SubjectAgg);

      map.set(name, mergeAgg(cur, dev));
    }

    const subjects = Array.from(map.values());
    subjects.sort((a, b) => (a.avgDeviation ?? 9999) - (b.avgDeviation ?? 9999));
    const weakest = subjects[0]?.avgDeviation != null ? subjects[0] : null;

    return { subjects, weakest };
  }

  // 旧形式（互換）
  if (!yearly || !Array.isArray(yearly.subjects)) {
    return { subjects: [], weakest: null };
  }

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

  return {
    subjects,
    weakest: sorted[0]?.deviation != null ? sorted[0] : null,
  };
}

/* =========================
   講評生成（commentary）
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
  const {
    tone,
    target,
    focus,
    singleAnalysis,
    yearlyAnalysis,
    singlesReportJson,
    yearlyReportJson,
  } = params;

  const payload = {
    settings: {
      tone,
      toneLabel: toneLabel(tone),
      target,
      targetLabel: targetLabel(target),
      focus: focus.map((x) => ({ key: x, label: focusLabel(x) })),
    },
    analysis: {
      singles: singleAnalysis,
      yearly: yearlyAnalysis,
    },
    singles: singlesReportJson.map((x) => ({
      name: x.name,
      reportJson: x.reportJson,
    })),
    yearly: yearlyReportJson,
  };

  const system = `
あなたは中学受験算数のプロ講師「まなぶ先生AI」です。

◆最重要の価値観
・「正しく解く力」よりも、「自分で考える力」を育てることを最優先にする。
・ミスは責めず、「次に伸びるヒント」として扱う。

◆話し方・トーン
・基本はやさしくフランク（優しさ7：厳しさ3）。ただし指摘すべき点は明確に。
・ユーザー設定 tone/target を必ず反映。

◆出力ルール
・日本語
・余計な前置きなし
・以下の構成で出す（対象に応じて言い回し調整）
  1) まず一言（共感/現状）
  2) 事実（数値の要約：弱点科目や2科/4科の状況など）
  3) 原因仮説（focusに沿って2〜4個）
  4) 次の一手（今日/今週でできる行動。具体）
  5) 最後に一言（対話を続ける問いかけ）
・数値がnullのものは無理に決めつけない。「未取得」と言う。
  `.trim();

  const user = `
以下は受験塾の成績表JSON（育成テスト/公開模試）と集計結果です。
このデータを元に「まなぶ先生AI」として講評を書いてください。

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

    /* ---------- UIからの入力 ---------- */

    // 単発：複数
    const singleFiles = fd
      .getAll("single")
      .filter((v): v is File => v instanceof File);

    // 年間：1枚
    const yearlyFileRaw = fd.get("yearly");
    const yearlyFile = yearlyFileRaw instanceof File ? yearlyFileRaw : null;

    // 講師設定
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

    /* ---------- Storage ---------- */
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

    /* ---------- Upload ---------- */
    const uploadedSingles: { path: string; name: string; size: number }[] = [];
    for (const f of singleFiles) uploadedSingles.push(await upload(f));

    const uploadedYearly = yearlyFile ? await upload(yearlyFile) : null;

    /* ---------- OCR + 成績表判定 + JSON化 ---------- */

    // 単発は枚数制限（Vercelタイムアウト対策）
    const MAX_SINGLE_OCR = 5;
    const singleTargets = uploadedSingles.slice(0, MAX_SINGLE_OCR);

    const singleOcrResults: any[] = [];
    for (const f of singleTargets) {
      try {
        const text = await ocrPdfFromStorage({
          bucket,
          path: f.path,
          filename: f.name,
        });

        const gradeCheck = await judgeGradeReport({
          filename: f.name,
          extractedText: text,
        });

        let reportJson: any | null = null;
        let reportJsonMeta: { ok: boolean; error: string | null } | null = null;

        if (gradeCheck.isGradeReport) {
          // ★修正：受験塾用（育成テスト/公開模試）JSON抽出に切替
          const extracted = await extractJukuReportJsonFromText({
            filename: f.name,
            extractedText: text,
          });

          reportJson = extracted.reportJson;
          reportJsonMeta = {
            ok: extracted.ok,
            error: extracted.ok ? null : extracted.error ?? "JSON化に失敗",
          };
        } else {
          reportJson = null;
          reportJsonMeta = {
            ok: false,
            error: "成績表ではないためJSON化をスキップ",
          };
        }

        singleOcrResults.push({
          ...f,
          ok: true,
          text,
          gradeCheck,
          reportJson,
          reportJsonMeta,
        });
      } catch (e: any) {
        console.error("[single OCR error]", f?.name, e);
        singleOcrResults.push({
          ...f,
          ok: false,
          error: e?.message ?? "OCR error",
          gradeCheck: {
            isGradeReport: false,
            confidence: 0,
            reason: "OCRに失敗したため判定できません",
          },
        });
      }
    }

    let yearlyOcrText: string | null = null;
    let yearlyOcrError: string | null = null;
    let yearlyJudgeError: string | null = null;

    let yearlyGradeCheck:
      | { isGradeReport: boolean; confidence: number; reason: string }
      | null = null;

    // ★ yearly も any で保持（JukuReportJsonになる）
    let yearlyReportJson: any | null = null;
    let yearlyReportJsonMeta: { ok: boolean; error: string | null } | null =
      null;

    if (uploadedYearly) {
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

      if (yearlyOcrText) {
        try {
          yearlyGradeCheck = await judgeGradeReport({
            filename: uploadedYearly.name,
            extractedText: yearlyOcrText,
          });
        } catch (e: any) {
          yearlyGradeCheck = {
            isGradeReport: false,
            confidence: 0,
            reason: "判定に失敗したため判定できません",
          };
          yearlyJudgeError = e?.message ?? "yearly judge error";
          console.error("[yearly judge error]", uploadedYearly?.name, e);
        }

        try {
          if (yearlyGradeCheck?.isGradeReport) {
            // ★修正：受験塾用（育成テスト/公開模試）JSON抽出に切替
            const extracted = await extractJukuReportJsonFromText({
              filename: uploadedYearly.name,
              extractedText: yearlyOcrText,
            });

            yearlyReportJson = extracted.reportJson;
            yearlyReportJsonMeta = {
              ok: extracted.ok,
              error: extracted.ok ? null : extracted.error ?? "JSON化に失敗",
            };
          } else {
            yearlyReportJson = null;
            yearlyReportJsonMeta = {
              ok: false,
              error: "成績表ではないためJSON化をスキップ",
            };
          }
        } catch (e: any) {
          console.error("[yearly JSON error]", uploadedYearly?.name, e);
          yearlyReportJson = null;
          yearlyReportJsonMeta = {
            ok: false,
            error: e?.message ?? "JSON化エラー",
          };
        }
      } else {
        yearlyGradeCheck = {
          isGradeReport: false,
          confidence: 0,
          reason: "OCRに失敗したため判定できません",
        };
      }
    }

    /* ---------- ②: JSONを使った分析集計（returnの直前で計算） ---------- */

    // ★既存の analyzeSinglesReportJson は reportJson.subjects を前提にしているため、
    //   受験塾JSONの場合は flatten した互換形式を作って突っ込む
    const singleJsonItems = (singleOcrResults ?? []).map((x: any) => {
      const r = x.reportJson;
      if (r && r.docType === "juku_report") {
        const rows = flattenJukuReportToSubjectsForAnalysis(r as JukuReportJson);
        return {
          filename: x.name,
          reportJson: {
            subjects: rows.map((row) => ({
              name: row.name,
              deviation: row.deviation,
            })),
          },
        };
      }
      return {
        filename: x.name,
        reportJson: x.reportJson,
      };
    });

    const singleAnalysis = analyzeSinglesReportJson(singleJsonItems);
    const yearlyAnalysis = analyzeYearlyReportJson(yearlyReportJson);

    /* ---------- ★追加：講評生成（commentary） ---------- */
    const singlesReportJson = (singleOcrResults ?? []).map((x: any) => ({
      name: x.name,
      reportJson: x.reportJson as any | null,
    }));

    const hasAnyReportJson =
      singlesReportJson.some((x) => !!x.reportJson) || !!yearlyReportJson;

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

    /* ---------- Response ---------- */
    return NextResponse.json({
      summary: `単発=${uploadedSingles.length}枚 / 年間=${
        uploadedYearly ? "あり" : "なし"
      }`,
      files: {
        singles: uploadedSingles,
        yearly: uploadedYearly,
      },
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

      selections: {
        tone,
        focus,
        target,
      },

      analysis: {
        singles: singleAnalysis,
        yearly: yearlyAnalysis,
      },

      // ★追加：講評（まなぶ先生AI）
      commentary,
    });
  } catch (e: any) {
    console.error("[route POST fatal]", e);
    return new NextResponse(e?.message ?? "Server error", { status: 500 });
  }
}
