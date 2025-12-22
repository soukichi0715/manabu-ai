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

function clampNum(n: any, min: number, max: number): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function normalizeTestTypeLabel(s: string) {
  const t = String(s ?? "").replace(/\s+/g, "");
  if (/(学習力育成テスト|育成テスト|学習力育成|育成)/.test(t)) return "ikusei";
  if (/(公開模試|公開模擬試験|公開模試成績|公開)/.test(t)) return "kokai_moshi";
  return "other";
}

function safeParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function isoDateOrNull(y: any, m: any, d: any): string | null {
  const yy = Number(y);
  const mm = Number(m);
  const dd = Number(d);
  if (!Number.isFinite(yy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;
  if (yy < 2000 || yy > 2100) return null;
  if (mm < 1 || mm > 12) return null;
  if (dd < 1 || dd > 31) return null;
  return `${yy.toString().padStart(4, "0")}-${mm.toString().padStart(2, "0")}-${dd
    .toString()
    .padStart(2, "0")}`;
}

/** テストの重複除去 */
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
    const system = `
あなたはPDF（テキスト/画像混在）から内容・レイアウト・改行・表構造をなるべく維持して全文を抽出するOCRです。
- ページ番号を付けて全文を出力
- 表は可能な範囲で表として表現
- 不明な箇所は「空欄」と明記
`.trim();

    const user = `
次のPDFをOCRしてください（全文）。推測はしないでください。
file_id: ${uploaded.id}
`.trim();

    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // file は Responses の input 参照で file_id 形式にしているのでここでは追加しない
    });

    return typeof resp.output_text === "string" ? resp.output_text.trim() : "";
  } finally {
    try {
      await openai.files.delete(uploaded.id);
    } catch {}
  }
}

/* =========================
   GradeReport 判定（軽量）
========================= */
async function judgeGradeReport(params: { filename: string; extractedText: string }) {
  const { filename, extractedText } = params;

  const system = `
あなたは「これは塾の成績表（育成テスト/公開模試などの推移表）か？」を判定します。
返答は必ずJSONで、キーは isGradeReport(boolean), confidence(0-100), reason(string) のみ。
`.trim();

  const user = `
ファイル名: ${filename}
本文（OCR）:
${extractedText.slice(0, 7000)}
`.trim();

  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const t = (typeof resp.output_text === "string" ? resp.output_text : "").trim();
  const j = safeParseJson<any>(t);
  if (j && typeof j.isGradeReport === "boolean") {
    return {
      isGradeReport: j.isGradeReport,
      confidence: typeof j.confidence === "number" ? j.confidence : 50,
      reason: typeof j.reason === "string" ? j.reason : "",
    };
  }
  // フォールバック
  const hit = /(育成|公開模試|偏差|成績|テスト|回)/.test(extractedText);
  return { isGradeReport: hit, confidence: hit ? 70 : 30, reason: "fallback keyword check" };
}

/* =========================
   JSON Schema / Types
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
      two: { score: number | null; deviation: number | null; rank: number | null; avg: number | null; diffFromAvg: number | null; grade: number | null };
      four: { score: number | null; deviation: number | null; rank: number | null; avg: number | null; diffFromAvg: number | null; grade: number | null };
    };
    notes: string[];
  }>;
  notes: string[];
};

const JUKU_REPORT_JSON_SCHEMA = {
  name: "juku_report_json",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      docType: { const: "juku_report" },
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
   想定平均（平均点が無い前提）
========================= */
const ASSUMED_AVERAGE = {
  kokaiDeviationAvg: 50, // 公開模試は偏差50を平均とみなす
  ikuseiGradeAvg: 6, // 育成は10段階で「平均=6（=平均を1点でも超えたら6が出る）」という運用前提
};

/* =========================
   学判除外
========================= */
function isGakuhanLike(s: string) {
  const t = String(s ?? "").replace(/\s+/g, "");
  return /(学判|学力判定|学力診断|学力到達度)/.test(t);
}

/* =========================
   ★修正：公開/育成の最終判定（公開模試の文字があれば優先）
========================= */
function inferTestTypeFromContent(t: any): "ikusei" | "kokai_moshi" | "other" {
  const name = String(t?.testName ?? t?.testType ?? "");
  const normalized = name.replace(/\s+/g, "");

  // 学判は除外
  if (isGakuhanLike(normalized)) return "other";

  // ★最優先：名前に「公開模試」が入っていたら偏差未抽出でも公開扱い
  if (/(公開模試|公開模擬試験|公開模試成績|公開)/.test(normalized)) return "kokai_moshi";

  // 公開の保険：偏差がどこかにある
  const hasDev =
    typeof t?.totals?.two?.deviation === "number" ||
    typeof t?.totals?.four?.deviation === "number" ||
    (Array.isArray(t?.subjects) && t.subjects.some((s: any) => typeof s?.deviation === "number"));
  if (hasDev) return "kokai_moshi";

  // 育成の判定：grade または diffFromAvg がどこかにある
  const hasIkuseiSignal =
    typeof t?.totals?.two?.grade === "number" ||
    typeof t?.totals?.four?.grade === "number" ||
    typeof t?.totals?.two?.diffFromAvg === "number" ||
    typeof t?.totals?.four?.diffFromAvg === "number" ||
    (Array.isArray(t?.subjects) && t.subjects.some((s: any) => typeof s?.diffFromAvg === "number"));

  if (hasIkuseiSignal) return "ikusei";

  return "other";
}

/* =========================
   Direct extraction from PDF (本命)
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
あなたは「塾の成績推移表（日能研など）」をPDF画像から正確に読み取り、JSON化する担当です。

【抽出対象（これ以外は拾わない）】
- 学習力育成テスト：回ごとの「得点」「評価（10段階）」があれば抽出。評価が無い場合は null でOK。
- 公開模試：回ごとの「得点」「偏差」を抽出（偏差は必ず“偏差”列から）

【除外（絶対に拾わない）】
- 学判／学力判定／学力診断／到達度 など

【抽出ルール（最重要）】
- “回ごとの表”は 1行=1回 → tests[] を必ず行数分作る（1回分しか無いなら1件）
- 育成：得点→totals.two.score / totals.four.score、評価→totals.two.grade / totals.four.grade（無ければ null）
- 公開：得点→totals.two.score / totals.four.score、偏差→totals.two.deviation / totals.four.deviation（無ければ null）
- 2科/4科の両方が無い場合は null
- 見えない/空欄は null。推測禁止。
- PDFに存在しない表・項目を作らない（幻覚禁止）

返答は必ずJSONのみ。前置き・説明は禁止。
`.trim()
        : `
あなたは「単発（1回分）の塾テスト成績表」をPDF画像から正確に読み取り、JSON化する担当です。

【抽出対象】
- そのPDFに含まれる 1回分のテスト結果（得点・偏差・平均との差・順位など見えるものだけ）

【ルール】
- 見えない/空欄は null。推測禁止。
- 返答は必ずJSONのみ。
`.trim();

    const user = `
次のPDFを読み取り、指定スキーマに沿ってJSON化してください。
file_id: ${uploaded.id}

- スキーマは「juku_report_json」です
- docType は "juku_report"
- meta.sourceFilename は "${filename}"
`.trim();

    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
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

    // 後処理：type正規化＆学判除外＆公開/育成の再判定
    parsed.tests = Array.isArray(parsed.tests) ? parsed.tests : [];
    for (const t of parsed.tests) {
      const nm = String(t?.testName ?? "");
      const tt = normalizeTestTypeLabel(nm);
      t.testType = (tt as any) ?? "other";
      // 最終判定（公開優先）
      t.testType = inferTestTypeFromContent(t);
    }

    // 学判除外＆公開/育成だけ残す
    parsed.tests = (parsed.tests ?? []).filter((t) => t.testType === "ikusei" || t.testType === "kokai_moshi");

    parsed.tests = dedupeTests(parsed.tests);

    // 並び順：育成→公開
    const order: Record<string, number> = { ikusei: 0, kokai_moshi: 1, other: 9 };
    parsed.tests.sort((a: any, b: any) => {
      const oa = order[a.testType] ?? 9;
      const ob = order[b.testType] ?? 9;
      if (oa !== ob) return oa - ob;
      return String(a.testName ?? "").localeCompare(String(b.testName ?? ""));
    });

    parsed.meta = parsed.meta ?? { sourceFilename: filename, title: null };
    if (parsed.meta.sourceFilename == null) parsed.meta.sourceFilename = filename;
    parsed.notes = Array.isArray(parsed.notes) ? parsed.notes : [];

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
   10段階評価の推定（diffFromAvgがある場合のみ）
   仕様：平均点が載っていないので、評価6が平均（=平均+1以上で6）
========================= */
function calcIkuseiGrade(diffFromAvg: number): number {
  // diffFromAvg: 本人-平均
  // 平均=6。そこから上下に振る（荒すぎないように±4まで）
  // 例：+1以上で6、+15で9、-15で3など（スケールは運用で調整可能）
  const base = 6;

  // ざっくり 7点差で1段階
  const step = Math.round(diffFromAvg / 7);

  let g = base + step;

  // 10〜3で分けたい
  if (g > 10) g = 10;
  if (g < 3) g = 3;

  return g;
}

/* =========================
   年間JSONの補正（育成のgradeが無い時に diffFromAvg から補う）
========================= */
function patchYearlyReportJson(yearly: JukuReportJson | null): JukuReportJson | null {
  if (!yearly) return null;

  for (const t of yearly.tests ?? []) {
    if (t.testType !== "ikusei") continue;

    t.totals = t.totals ?? {
      two: { score: null, deviation: null, rank: null, avg: null, diffFromAvg: null, grade: null },
      four: { score: null, deviation: null, rank: null, avg: null, diffFromAvg: null, grade: null },
    };

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

    t.totals.two = { ...two };
    t.totals.four = { ...four };

    // grade が無ければ diffFromAvg から推定（diffFromAvgがある場合のみ）
    if (t.totals.two.grade == null && typeof t.totals.two.diffFromAvg === "number") {
      t.totals.two.grade = calcIkuseiGrade(t.totals.two.diffFromAvg);
    }
    if (t.totals.four.grade == null && typeof t.totals.four.diffFromAvg === "number") {
      t.totals.four.grade = calcIkuseiGrade(t.totals.four.diffFromAvg);
    }
  }

  return yearly;
}

/* =========================
   年間推移：トレンド計算
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
    .map((t) => (typeof t.totals?.two?.grade === "number" ? t.totals.two.grade : t.totals?.four?.grade))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const kokaiVals: number[] = tests
    .filter((t) => t.testType === "kokai_moshi")
    .map((t) => (typeof t.totals?.two?.deviation === "number" ? t.totals.two.deviation : t.totals?.four?.deviation))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const ikuseiTrend = judgeTrend(ikuseiVals, 1); // 評価は±1で傾向
  const kokaiTrend = judgeTrend(kokaiVals, 3); // 偏差は±3で傾向

  return {
    ikusei: { trend: ikuseiTrend, values: ikuseiVals },
    kokai: { trend: kokaiTrend, values: kokaiVals },
  };
}

/* =========================
   講評生成（超簡易）
========================= */
async function generateCommentary(payload: any) {
  const system = `
あなたは塾講師です。以下の成績推移データから、短く・前向きに講評を書いてください。
- 育成：評価（10段階）を中心に、平均=6と比較して上/下を表現
- 公開：偏差（平均=50）を中心に、上昇/下降を表現
- 傾向が「up」なら「上昇傾向」/「down」なら「下降傾向、ここから伸ばそう」/「flat」なら「安定」/「unknown」なら「データ不足」
`.trim();

  const user = `
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

    // -------- singles（単発）：今は従来通り OCR→抽出（必要なら後でdirectに統一可能） --------
    const singleOcrResults: any[] = [];
    for (const f of singleTargets) {
      try {
        const text = await ocrPdfFromStorage({ bucket, path: f.path, filename: f.name });
        const gradeCheck = await judgeGradeReport({ filename: f.name, extractedText: text });

        let reportJson: any | null = null;
        let reportJsonMeta: { ok: boolean; error: string | null } | null = null;
        let debug: any | null = null;

        if (gradeCheck.isGradeReport) {
          // 単発も direct 抽出を優先（幻覚対策）
          const extracted = await extractJukuReportJsonDirectFromPdf({
            bucket,
            path: f.path,
            filename: f.name,
            mode: "single",
          });
          reportJson = extracted.reportJson;
          reportJsonMeta = { ok: extracted.ok, error: extracted.ok ? null : extracted.error ?? "JSON化に失敗" };
          debug = { mode: "single-direct", rawLen: extracted.raw?.length ?? 0 };
        } else {
          reportJson = null;
          reportJsonMeta = { ok: false, error: "成績表ではないと判定" };
        }

        singleOcrResults.push({
          file: f,
          ok: true,
          text,
          gradeCheck,
          reportJson,
          reportJsonMeta,
          debug,
        });
      } catch (e: any) {
        singleOcrResults.push({
          file: f,
          ok: false,
          error: e?.message ?? "single OCR error",
        });
      }
    }

    // yearly
    let yearlyOcrText: string | null = null;
    let yearlyOcrError: string | null = null;

    let yearlyReportJson: any | null = null;
    let yearlyReportJsonMeta: { ok: boolean; error: string | null } | null = null;
    let yearlyDebug: any | null = null;

    if (uploadedYearly) {
      // 参考用OCR（失敗しても致命傷にしない）
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

      // 本命：direct抽出（育成＋公開のみ）
      const extractedYearly = await extractJukuReportJsonDirectFromPdf({
        bucket,
        path: uploadedYearly.path,
        filename: uploadedYearly.name,
        mode: "yearly",
      });

      yearlyReportJson = patchYearlyReportJson(extractedYearly.reportJson);
      yearlyReportJsonMeta = {
        ok: extractedYearly.ok,
        error: extractedYearly.ok ? null : extractedYearly.error ?? "JSON化に失敗",
      };
      yearlyDebug = { mode: "yearly-direct", rawLen: extractedYearly.raw?.length ?? 0 };
    }

    // yearly trends（育成=評価、公開=偏差）
    const trends = extractYearlyTrends(yearlyReportJson as any);

    // 講評（単発メインを想定しつつ、年間推移も添える）
    const commentary = await generateCommentary({
      assumedAverage: ASSUMED_AVERAGE,
      yearly: { trends },
      note: "メインは単発分析。年間は推移補助。",
    });

    return NextResponse.json({
      summary: `単発=${uploadedSingles.length}枚 / 年間=${uploadedYearly ? "あり" : "なし"}`,
      files: {
        singles: uploadedSingles,
        yearly: uploadedYearly,
      },
      ocr: {
        singles: singleOcrResults,
        yearly: yearlyOcrText,
        yearlyError: yearlyOcrError,
        yearlyReportJson,
        yearlyReportJsonMeta,
        yearlyDebug,
      },
      assumedAverage: ASSUMED_AVERAGE,
      yearlyTrends: trends,
      commentary,
    });
  } catch (e: any) {
    console.error("[route POST fatal]", e);
    return new NextResponse(e?.message ?? "Server error", { status: 500 });
  }
}
