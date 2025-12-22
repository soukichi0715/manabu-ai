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
   Assumed averages（追加）
   - 公開模試：偏差50が平均
   - 育成：評価10段階、平均との差+1以上で平均超え＝6（平均の基準点）
========================= */
const ASSUMED_AVERAGE = {
  kokaiDeviation: 50,
  ikuseiGradeBase: 6,
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

/* =========================
   育成：diffFromAvg → 10〜3 評価（追加）
   - 平均（基準点）＝6
   - 「平均との差が +1 点以上で 6」
   - そこから上位/下位を段階的に分ける
========================= */
function calcIkuseiGrade(diffFromAvg: number): number {
  if (!Number.isFinite(diffFromAvg)) return ASSUMED_AVERAGE.ikuseiGradeBase; // 保険（通常ここは通らない）

  if (diffFromAvg >= 8) return 10;
  if (diffFromAvg >= 6) return 9;
  if (diffFromAvg >= 4) return 8;
  if (diffFromAvg >= 2) return 7;
  if (diffFromAvg >= 1) return 6;
  if (diffFromAvg >= -1) return 5;
  if (diffFromAvg >= -3) return 4;
  return 3; // 下限固定
}

/* =========================
   Trend判定（追加）
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

  // kokai
  if (t === "up")
    return "公開模試は回を重ねるごとに偏差が上がっており、上昇傾向です。成果が形になってきています。";
  if (t === "down")
    return "公開模試は回を追うごとに偏差が下がっています。ここが踏ん張りどころ。がんばっていこう。";
  return "公開模試は横ばいです。あと一段の得点力アップを狙っていこう。";
}

/* =========================
   OCR（参考用：デバッグ/確認）
   ※年間はdirect抽出が本命。OCRテキストは信用しない。
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
        grade: number | null; // 育成の「評価」をここに入れる（10〜3に拡張）
      };
      four: {
        score: number | null;
        deviation: number | null;
        rank: number | null;
        avg: number | null;
        diffFromAvg: number | null;
        grade: number | null; // 育成の「評価」をここに入れる（10〜3に拡張）
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
   Grade fallback (育成の評価の救済)
   ※ もともとの関数は残しつつ、10〜3にも対応（修正）
========================= */
function pickGradeFallback(t: any): number | null {
  const cands = [
    t?.totals?.two?.grade,
    t?.totals?.four?.grade,
    t?.totals?.two?.deviation,
    t?.totals?.four?.deviation,
    t?.totals?.two?.rank,
    t?.totals?.four?.rank,
  ];
  for (const v of cands) {
    // 10〜3評価にも対応（0〜5限定から変更）
    if (typeof v === "number" && Number.isFinite(v) && v >= 3 && v <= 10) return v;
  }
  return null;
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

  const system =
    mode === "yearly"
      ? `
あなたは「塾の成績推移表（日能研など）」をPDF画像から正確に読み取り、JSON化する担当です。

【このPDFで必ず探す（重要）】
- 学習力育成テスト：回ごとの「得点」「評価（10段階）」または「平均との差（diffFromAvg）」があれば必ず抽出
- 公開模試：回ごとの「得点」「偏差」
- 合格力実践テスト/合格力育成テスト：同様に回ごとに表があれば抽出

【抽出ルール】
- “回ごとの表”は 1行=1回 → tests[] を必ず行数分作る
- 育成：得点は totals.two.score / totals.four.score、評価は totals.two.grade / totals.four.grade（無いなら null）、平均との差は totals.*.diffFromAvg
- 公開：得点は totals.*.score、偏差は totals.*.deviation
- 教科列（国/算/理/社）があるなら subjects[] にも入れる（無いなら nullでOK）
- 見えない/空欄は null。推測禁止。
- PDFに存在しない表・項目を作らない（幻覚禁止）
`.trim()
      : `
あなたは「単発（1回分）の塾テスト成績表」をPDF画像から正確に読み取り、JSON化する担当です。
育成/公開模試などが1回分載っている場合、それを tests[] に入れる。推測禁止。幻覚禁止。
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
              "このPDFから『育成=得点(+平均との差)→評価10〜3へ変換』『公開=得点+偏差』の回ごとの推移をJSON化してください。推測は禁止。空欄はnull。",
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

  // ===== 修正①：testName優先で testType を確定（other対策） =====
  parsed.tests = (parsed.tests ?? []).map((t) => {
    const tt = normalizeTestTypeLabel(t.testName || t.testType || "other") as any;
    return { ...t, testType: tt };
  });

  // 後処理：範囲チェック等
  for (const t of parsed.tests ?? []) {
    // subjects name補正
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

    // ★gradeの範囲を 0-5 から 0-10 に拡張（修正）
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

    // ===== 修正②：育成テストだけ grade を救済（10〜3） =====
    if (t.testType === "ikusei") {
      // 2科
      const g2 = pickGradeFallback(t);
      if (t.totals.two.grade == null) t.totals.two.grade = g2;

      // 4科
      const g4 = pickGradeFallback(t);
      if (t.totals.four.grade == null) t.totals.four.grade = g4;

      // ★ここが本命：平均との差（diffFromAvg）から 10〜3 を算出（追加）
      if (t.totals.two.grade == null && typeof t.totals.two.diffFromAvg === "number") {
        t.totals.two.grade = calcIkuseiGrade(t.totals.two.diffFromAvg);
      }
      if (t.totals.four.grade == null && typeof t.totals.four.diffFromAvg === "number") {
        t.totals.four.grade = calcIkuseiGrade(t.totals.four.diffFromAvg);
      }
    }

    // date整形
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
    return String(a.testName ?? "").localeCompare(String(b.testName ?? ""));
  });

  parsed.meta = parsed.meta ?? { sourceFilename: filename, title: null };
  if (parsed.meta.sourceFilename == null) parsed.meta.sourceFilename = filename;
  parsed.notes = Array.isArray(parsed.notes) ? parsed.notes : [];

  return { ok: true, reportJson: parsed, raw: out, error: null };
}

/* =========================
   Analysis
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
    // 公開模試だけ偏差を分析に使う（育成は評価で見る）
    if (t.testType !== "kokai_moshi") continue;
    for (const s of t.subjects ?? []) {
      const nm = String(s?.name ?? "").trim();
      if (!nm) continue;
      rows.push({ name: nm, deviation: safeNum(s?.deviation) });
    }
  }
  return rows;
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
   年間推移：トレンド計算（追加）
   - 育成：grade（評価）を回順で見て、±1で判定
   - 公開：偏差を回順で見て、±3で判定
========================= */
function extractYearlyTrends(yearly: JukuReportJson | null) {
  if (!yearly) {
    return {
      ikusei: { trend: "unknown" as Trend, values: [] as number[] },
      kokai: { trend: "unknown" as Trend, values: [] as number[] },
    };
  }

  const tests = yearly.tests ?? [];

  // できるだけ「2科 totals.two」を優先。無ければ four を補助で使う。
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

  const ikuseiTrend = judgeTrend(ikuseiVals, 1);
  const kokaiTrend = judgeTrend(kokaiVals, 3);

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

    // singles（単発）は今回は未使用でもOK：メインは単発で分析したいなら、後でここを作りこむ
    const singleOcrResults: any[] = [];

    // yearly（年間）：direct抽出が本命
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

      // 本命：direct抽出
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

    const yearlyAnalysis = analyzeYearlyReportJson(yearlyReportJson);

    // ★追加：育成/公開の「回ごとの推移」トレンド
    const yearlyTrends = extractYearlyTrends(yearlyReportJson as JukuReportJson | null);

    // ★追加：トレンドに応じたメッセージ（がんばっていこう含む）
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
        yearly: yearlyAnalysis,
        // ★追加：trend結果をanalysisに同梱
        trends: {
          assumedAverage: ASSUMED_AVERAGE,
          ikusei: yearlyTrends.ikusei,
          kokai: yearlyTrends.kokai,
        },
      },
      // 既存commentaryは残しつつ、trend用のcommentaryも追加
      commentary:
        uploadedSingles.length === 0
          ? "単発PDFが未投入です。メイン分析は単発（育成/公開の1回分）を入れると精度が上がります。年間は推移の補助として扱います。"
          : "単発PDFを元に分析します。",
      // ★追加：推移コメント
      trendCommentary,
    });
  } catch (e: any) {
    console.error("[route POST fatal]", e);
    return new NextResponse(e?.message ?? "Server error", { status: 500 });
  }
}
