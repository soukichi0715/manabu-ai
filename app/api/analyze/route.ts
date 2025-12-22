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
   Assumed averages
========================= */
const ASSUMED_AVERAGE = {
  kokaiDeviation: 50, // 公開模試：偏差50が平均
  ikuseiGradeBase: 6, // 育成：10段階評価の平均基準（平均との差+1で6相当）
} as const;

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

/** 学判（学力判定など）を除外対象として判定 */
function isGakuhanLike(testNameOrType: string) {
  const t = String(testNameOrType ?? "").replace(/\s+/g, "");
  return /(学判|学力判定|学力診断|学力テスト|学力到達度|到達度テスト)/.test(t);
}

/** 取得対象は「育成」「公開」だけ */
function normalizeTestTypeLabel(s: string) {
  const t = String(s ?? "").replace(/\s+/g, "");

  // 学判は存在しても "other" 扱いにして後で落とす（＝絶対残さない）
  if (isGakuhanLike(t)) return "other";

  if (/(学習力育成テスト|育成テスト|学習力育成|育成)/.test(t)) return "ikusei";
  if (/(公開模試|公開模擬試験|公開模試成績|公開)/.test(t)) return "kokai_moshi";
  return "other";
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

/* =========================
   育成：diffFromAvg → 10〜3 評価
========================= */
function calcIkuseiGrade(diffFromAvg: number): number {
  if (!Number.isFinite(diffFromAvg)) return ASSUMED_AVERAGE.ikuseiGradeBase;

  if (diffFromAvg >= 8) return 10;
  if (diffFromAvg >= 6) return 9;
  if (diffFromAvg >= 4) return 8;
  if (diffFromAvg >= 2) return 7;
  if (diffFromAvg >= 1) return 6;
  if (diffFromAvg >= -1) return 5;
  if (diffFromAvg >= -3) return 4;
  return 3;
}

/* =========================
   Trend判定
========================= */
type Trend = "up" | "down" | "flat" | "unknown";

function judgeTrend(values: number[], threshold: number): Trend {
  if (!Array.isArray(values) || values.length < 2) return "unknown";
  const first = values[0];
  const last = values[values.length - 1];
  if (!Number.isFinite(first) || !Number.isFinite(last)) return "unknown";

  if (last - first >= threshold) return "up";
  if (first - last >= threshold) return "down";
  return "flat";
}

function trendToMessage(kind: "ikusei" | "kokai", t: Trend): string {
  if (t === "unknown") return "まだ回数が少ないため、今後の推移を見て判断していきましょう。";

  if (kind === "ikusei") {
    if (t === "up")
      return "育成は回を重ねるごとに評価が上がっており、上昇傾向です。この調子でいこう。";
    if (t === "down")
      return "育成は回を追うごとに評価が下がっています。ここから立て直して、がんばっていこう。";
    return "育成は大きな上下がなく横ばいです。次の一段階へ、復習の質を上げていこう。";
  }

  if (t === "up")
    return "公開模試は回を重ねるごとに偏差が上がっており、上昇傾向です。成果が形になってきています。";
  if (t === "down")
    return "公開模試は回を追うごとに偏差が下がっています。ここが踏ん張りどころ。がんばっていこう。";
  return "公開模試は横ばいです。あと一段の得点力アップを狙っていこう。";
}

/* =========================
   ★追加：内容から testType を推定して補正
   - 偏差(deviation)があれば公開
   - grade / diffFromAvg があれば育成
   - 学判は除外
========================= */
function inferTestTypeFromContent(t: any): "ikusei" | "kokai_moshi" | "other" {
  const name = String(t?.testName ?? t?.testType ?? "");
  if (isGakuhanLike(name)) return "other";

  // 公開の判定：偏差がどこかにある
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
   OCR（参考）
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
              "必ず全ページをOCRし、ページ番号を付けて順番通りに全文転記してください。要約禁止。省略禁止。表略禁止。推測で埋めない。出力はOCR転記のみ。",
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
   Schema (juku_report)
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
        grade: number | null; // 育成の評価（10〜3）
      };
      four: {
        score: number | null;
        deviation: number | null;
        rank: number | null;
        avg: number | null;
        diffFromAvg: number | null;
        grade: number | null; // 育成の評価（10〜3）
      };
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

  const system =
    mode === "yearly"
      ? `
あなたは「塾の成績推移表」をPDF画像から正確に読み取り、JSON化する担当です。

【抽出対象（これ以外は拾わない）】
- 学習力育成テスト：回ごとの「得点」「平均との差（diffFromAvg）」があれば抽出（評価列が無ければ null）
- 公開模試：回ごとの「得点」「偏差」

【除外（絶対に拾わない）】
- 学判／学力判定／学力診断など（この系統は不要）

【抽出ルール】
- “回ごとの表”は 1行=1回 → tests[] を必ず行数分作る
- 育成：得点は totals.*.score、平均との差は totals.*.diffFromAvg、評価は totals.*.grade（無ければ null）
- 公開：得点は totals.*.score、偏差は totals.*.deviation
- 見えない/空欄は null。推測禁止。
- PDFに存在しない表・項目を作らない（幻覚禁止）
`.trim()
      : `
あなたは「単発（1回分）の塾テスト成績表」をPDF画像から正確に読み取り、JSON化する担当です。
抽出対象は「学習力育成テスト」「公開模試」のみ。推測禁止。幻覚禁止。
`.trim();

  const resp = await openai.responses.create({
    model: "gpt-4.1",
    input: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "input_file", file_id: uploaded.id },
          {
            type: "input_text",
            text:
              `ファイル名: ${filename}\n` +
              "このPDFから『育成=得点(+平均との差)』『公開=得点+偏差』の回ごとの推移をJSON化してください。推測は禁止。空欄はnull。",
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

  // いったん testName 優先で分類（ただし「第1回」などは other になりがち）
  parsed.tests = (parsed.tests ?? []).map((t) => {
    const tt = normalizeTestTypeLabel(t.testName || t.testType || "other") as any;
    return { ...t, testType: tt };
  });

  // 後処理：範囲チェック + 育成grade算出 + content推定で再分類
  for (const t of parsed.tests ?? []) {
    t.subjects = (t.subjects ?? []).map((s: any) => {
      const rawName = String(s?.name ?? "").trim();
      const fixed = rawName === "数学" ? "算数" : rawName;
      const name = (["国語", "算数", "理科", "社会"].includes(fixed) ? fixed : "不明") as any;
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
      deviation: clampNum(two.deviation, 10, 90),
      rank: clampNum(two.rank, 1, 50000),
      avg: clampNum(two.avg, 0, 400),
      diffFromAvg: clampNum(two.diffFromAvg, -400, 400),
      grade: clampNum(two.grade, 0, 10),
    };
    t.totals.four = {
      score: clampNum(four.score, 0, 500),
      deviation: clampNum(four.deviation, 10, 90),
      rank: clampNum(four.rank, 1, 50000),
      avg: clampNum(four.avg, 0, 500),
      diffFromAvg: clampNum(four.diffFromAvg, -500, 500),
      grade: clampNum(four.grade, 0, 10),
    };

    // 育成：gradeが無いなら diffFromAvg から 10〜3 を算出
    // （※この時点では testType が other の可能性があるので、先に算出してから推定分類する）
    if (t.totals.two.grade == null && typeof t.totals.two.diffFromAvg === "number") {
      t.totals.two.grade = calcIkuseiGrade(t.totals.two.diffFromAvg);
    }
    if (t.totals.four.grade == null && typeof t.totals.four.diffFromAvg === "number") {
      t.totals.four.grade = calcIkuseiGrade(t.totals.four.diffFromAvg);
    }

    // ★追加：内容から最終 testType を推定（第1回…問題の解決）
    const inferred = inferTestTypeFromContent(t);
    if (inferred !== "other") {
      t.testType = inferred;
    }

    // date整形
    if (t.date && /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(t.date)) {
      const [y, m, d] = t.date.split(/[-/]/);
      t.date = isoDateOrNull(y, m, d);
    }

    t.notes = Array.isArray(t.notes) ? t.notes : [];
  }

  // ★ここが重要：最終的に ikusei / kokai_moshi だけ残す（学判含むotherは消す）
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
}

/* =========================
   年間推移：トレンド計算
========================= */
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
    .map((t) =>
      typeof t.totals?.two?.deviation === "number" ? t.totals.two.deviation : t.totals?.four?.deviation
    )
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const ikuseiTrend = judgeTrend(ikuseiVals, 1); // 評価は±1で傾向
  const kokaiTrend = judgeTrend(kokaiVals, 3); // 偏差は±3で傾向

  return {
    ikusei: { trend: ikuseiTrend, values: ikuseiVals },
    kokai: { trend: kokaiTrend, values: kokaiVals },
  };
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

    // singles はここでは未解析（メイン分析は単発で別ロジック想定のまま）
    const singleOcrResults: any[] = [];

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

    // trend
    const yearlyTrends = extractYearlyTrends(yearlyReportJson as JukuReportJson | null);
    const trendCommentary = {
      ikusei: trendToMessage("ikusei", yearlyTrends.ikusei.trend),
      kokai: trendToMessage("kokai", yearlyTrends.kokai.trend),
    };

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
        note: null,
      },
      analysis: {
        singles: { subjects: [], weakest: null },
        trends: {
          assumedAverage: ASSUMED_AVERAGE,
          ikusei: yearlyTrends.ikusei,
          kokai: yearlyTrends.kokai,
        },
      },
      commentary:
        uploadedSingles.length === 0
          ? "単発PDFが未投入です。メイン分析は単発（育成/公開の1回分）を入れると精度が上がります。年間は推移の補助として扱います。"
          : "単発PDFを元に分析します。",
      trendCommentary,
    });
  } catch (e: any) {
    console.error("[route POST fatal]", e);
    return new NextResponse(e?.message ?? "Server error", { status: 500 });
  }
}
