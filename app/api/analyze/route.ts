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
  if (/(公開模試|公開模擬試験|公開模試成績|公開模試試験成績|公開)/.test(t)) return "kokai_moshi";
  return "other";
}

function safeParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
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

function isoDateOrNull(y: any, m: any, d: any): string | null {
  const yy = Number(y);
  const mm = Number(m);
  const dd = Number(d);
  if (!Number.isFinite(yy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;
  if (yy < 2000 || yy > 2100) return null;
  if (mm < 1 || mm > 12) return null;
  if (dd < 1 || dd > 31) return null;
  const s = `${yy.toString().padStart(4, "0")}-${mm.toString().padStart(2, "0")}-${dd
    .toString()
    .padStart(2, "0")}`;
  return s;
}

/* =========================
   OCR (text)  ※単発用の保険として残す
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
            text:
              "このPDFはスキャン画像の可能性があります。必ず全ページをOCRし、ページ番号を付けて順番通りに全文出力してください。要約は禁止。省略禁止。表略・抜粋・個人情報保護のため省略、などの自己判断による省略は絶対にしないでください。推測で埋めないでください。出力はOCR転記のみ（解釈・編集なし）。",
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
   Direct extraction from PDF (yearly優先 / 幻覚対策)
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
      two: { score: number | null; deviation: number | null; rank: number | null; avg: number | null; diffFromAvg: number | null; grade: number | null };
      four: { score: number | null; deviation: number | null; rank: number | null; avg: number | null; diffFromAvg: number | null; grade: number | null };
    };
    notes: string[];
  }>;
  notes: string[];
};

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

  const system =
    mode === "yearly"
      ? `
あなたは「日能研などの塾の成績推移表」をPDF画像から正確に読み取って、JSON化する担当です。

【このPDFで必ず探す表（重要）】
- I. 前年度学習力育成テスト平均（年間）
- III. 前期学習力育成テスト（回ごとの得点・評価）
- IV. 前年度公開模試平均
- V. 公開模試試験成績（回ごとの得点・偏差）
- 合格力実践テスト / 合格力育成テスト（下部に表がある場合）

【抽出ルール（最重要）】
- “回ごとの表”は 1行=1回 → tests[] を必ず行数分作る
- 育成（学習力育成テスト）は「得点」「評価」を取り、totals.two/four の score と grade に入れる（偏差は null）
- 公開模試は「得点」「偏差」を取り、totals.two/four の score と deviation に入れる（grade は null）
- 年/月/日 がある行は date=YYYY-MM-DD にする（無ければ null）
- 国語/算数/社会/理科 も列があれば subjects に入れる（無ければ全て null でOK）
- “見えない/空欄”は null（絶対に推測で埋めない）
- PDFに存在しない表を作らない（幻覚禁止）

【禁止事項】
- 期末テスト点数分布、提出物状況、観点別評価など「このPDFに無い」項目を捏造しない
- 別帳票を混ぜない

出力は JSONスキーマ厳守。
`.trim()
      : `
あなたは「単発のテスト結果（1回分の成績表）」をPDF画像から正確に読み取りJSON化する担当です。
育成テスト/公開模試/合格力実践テスト等が1回分載っている場合、それを tests[] に入れる。
見えない値は null。推測禁止。幻覚禁止。JSONスキーマ厳守。
`.trim();

  const resp = await openai.responses.create({
    model: "gpt-4.1",
    input: [
      {
        role: "system",
        content: system,
      },
      {
        role: "user",
        content: [
          { type: "input_file", file_id: uploaded.id },
          {
            type: "input_text",
            text:
              `ファイル名: ${filename}\n` +
              "上のPDFから、塾の成績推移（育成=得点+評価 / 公開=得点+偏差）をJSON化してください。推測は禁止。空欄はnull。",
          },
        ],
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

  try {
    await openai.files.delete(uploaded.id);
  } catch {}

  const out = (resp.output_text ?? "").trim();
  const parsed = safeParseJson<JukuReportJson>(out);

  if (!parsed || parsed.docType !== "juku_report") {
    return { ok: false, reportJson: null, raw: out, error: "JSONの解析に失敗（フォーマット不正）" };
  }

  // 後処理：type補正・表記ゆれ補正・範囲チェック
  parsed.tests = (parsed.tests ?? []).map((t) => {
    const tt = normalizeTestTypeLabel(t.testType || t.testName || "other") as any;
    return { ...t, testType: tt };
  });

  for (const t of parsed.tests ?? []) {
    t.subjects = (t.subjects ?? []).map((s: any) => {
      const rawName = String(s?.name ?? "").trim();
      const fixedName = rawName === "数学" ? "算数" : rawName;
      return { ...s, name: fixedName };
    });

    // totals クリーニング
    const two = t.totals?.two ?? { score: null, deviation: null, rank: null, avg: null, diffFromAvg: null, grade: null };
    const four = t.totals?.four ?? { score: null, deviation: null, rank: null, avg: null, diffFromAvg: null, grade: null };

    t.totals.two = {
      score: clampNum(two.score, 0, 400),
      deviation: clampNum(two.deviation, 10, 90),
      rank: clampNum(two.rank, 1, 50000),
      avg: clampNum(two.avg, 0, 400),
      diffFromAvg: clampNum(two.diffFromAvg, -400, 400),
      grade: clampNum(two.grade, 0, 5),
    };
    t.totals.four = {
      score: clampNum(four.score, 0, 500),
      deviation: clampNum(four.deviation, 10, 90),
      rank: clampNum(four.rank, 1, 50000),
      avg: clampNum(four.avg, 0, 500),
      diffFromAvg: clampNum(four.diffFromAvg, -500, 500),
      grade: clampNum(four.grade, 0, 5),
    };

    // subjects クリーニング
    t.subjects = (t.subjects ?? []).map((s: any) => {
      const nameRaw = String(s?.name ?? "").trim();
      const normalizedName = nameRaw === "数学" ? "算数" : nameRaw;
      const name = (["国語", "算数", "理科", "社会"].includes(normalizedName) ? normalizedName : "不明") as any;

      return {
        ...s,
        name,
        score: clampNum(s.score, 0, 200),
        deviation: clampNum(s.deviation, 10, 90),
        rank: clampNum(s.rank, 1, 50000),
        avg: clampNum(s.avg, 0, 200),
        diffFromAvg: clampNum(s.diffFromAvg, -200, 200),
      };
    });

    // date整形（年/月/日をそのまま入れてくるモデル対策）
    if (t.date && /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(t.date)) {
      const [y, m, d] = t.date.split(/[-/]/);
      t.date = isoDateOrNull(y, m, d);
    }

    t.notes = Array.isArray(t.notes) ? t.notes : [];
  }

  parsed.tests = dedupeTests(parsed.tests);

  // 並び順：育成→公開→その他
  const order: Record<string, number> = { ikusei: 0, kokai_moshi: 1, other: 9 };
  parsed.tests.sort((a: any, b: any) => {
    const oa = order[a.testType] ?? 9;
    const ob = order[b.testType] ?? 9;
    if (oa !== ob) return oa - ob;
    return String(a.date ?? "").localeCompare(String(b.date ?? ""));
  });

  parsed.meta = parsed.meta ?? { sourceFilename: filename, title: null };
  if (parsed.meta.sourceFilename == null) parsed.meta.sourceFilename = filename;
  parsed.notes = Array.isArray(parsed.notes) ? parsed.notes : [];

  return { ok: true, reportJson: parsed, raw: out, error: null };
}

/* =========================
   Analysis (既存のまま)
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
   Commentary (既存のまま)
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

    // -------- singles（単発）：今は従来通り OCR→抽出（必要なら後でdirectに統一可能） --------
    const singleOcrResults: any[] = [];
    for (const f of singleTargets) {
      try {
        const text = await ocrPdfFromStorage({ bucket, path: f.path, filename: f.name });

        // 単発は direct 抽出を優先（幻覚対策）
        const extracted = await extractJukuReportJsonDirectFromPdf({
          bucket,
          path: f.path,
          filename: f.name,
          mode: "single",
        });

        singleOcrResults.push({
          ...f,
          ok: true,
          text,
          gradeCheck: { isGradeReport: true, confidence: 80, reason: "単発はdirect抽出で処理", reportKind: "juku" },
          reportJson: extracted.reportJson,
          reportJsonMeta: { ok: extracted.ok, error: extracted.ok ? null : extracted.error ?? "JSON化に失敗" },
          debug: { mode: "single-direct", rawLen: extracted.raw?.length ?? 0 },
        });
      } catch (e: any) {
        console.error("[single OCR/direct error]", f?.name, e);
        singleOcrResults.push({
          ...f,
          ok: false,
          error: e?.message ?? "single error",
          gradeCheck: { isGradeReport: false, confidence: 0, reason: "処理に失敗したため判定できません", reportKind: "juku" },
        });
      }
    }

    // -------- yearly（年間）：OCR全文は参考で返すが、抽出は direct を必ず使う --------
    let yearlyOcrText: string | null = null;
    let yearlyOcrError: string | null = null;

    let yearlyReportJson: any | null = null;
    let yearlyReportJsonMeta: { ok: boolean; error: string | null } | null = null;
    let yearlyDebug: any | null = null;

    if (uploadedYearly) {
      // 参考用OCR（失敗しても致命傷にしない）
      try {
        yearlyOcrText = await ocrPdfFromStorage({ bucket, path: uploadedYearly.path, filename: uploadedYearly.name });
      } catch (e: any) {
        yearlyOcrText = null;
        yearlyOcrError = e?.message ?? "yearly OCR error";
        console.error("[yearly OCR error]", uploadedYearly?.name, e);
      }

      // 本命：direct抽出
      const extractedYearly = await extractJukuReportJsonDirectFromPdf({
        bucket,
        path: uploadedYearly.path,
        filename: uploadedYearly.name,
        mode: "yearly",
      });

      yearlyReportJson = extractedYearly.reportJson;
      yearlyReportJsonMeta = { ok: extractedYearly.ok, error: extractedYearly.ok ? null : extractedYearly.error ?? "JSON化に失敗" };
      yearlyDebug = { mode: "yearly-direct", rawLen: extractedYearly.raw?.length ?? 0 };
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
        yearlyReportJson,
        yearlyReportJsonMeta,
        yearlyDebug,
        note: uploadedSingles.length > MAX_SINGLE_OCR ? `単発PDFが多いため、先頭${MAX_SINGLE_OCR}枚のみ処理しました` : null,
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
