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
  const { data: pdfBlob, error } = await supabase.storage.from(bucket).download(path);

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
    model: "gpt-4.1-mini",
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

  // ※Responses API は output_text を使うのが型的に安全
  return typeof resp.output_text === "string" ? resp.output_text : "";
}

/* =========================
   JSON schema（抽出）
========================= */
type ReportJson = {
  docType: "report";
  student: { name: string | null; id: string | null };
  test: { name: string | null; date: string | null };
  overall: { score: number | null; deviation: number | null; rank: number | null; avg: number | null };
  subjects: { name: string; score: number | null; deviation: number | null; avg: number | null; rank: number | null }[];
  notes: string[];
};

function safeParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** OCRテキストから成績表JSONを抽出（MVP） */
async function extractReportJsonFromText(params: {
  filename: string;
  extractedText: string;
}) {
  const { filename, extractedText } = params;

  // 長すぎると遅くなるので適度に圧縮（先頭＋末尾）
  const head = extractedText.slice(0, 4000);
  const tail = extractedText.slice(-4000);
  const snippet = `${head}\n...\n${tail}`;

  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content:
          "あなたは学習塾の成績表データ化担当です。OCRテキストから成績表の数値を構造化JSONにします。" +
          "推測は禁止。見えない/不明はnullにしてください。日本語を尊重し、科目名は「国語/算数/理科/社会」を優先してください。",
      },
      {
        role: "user",
        content:
          `ファイル名: ${filename}\n\n` +
          "次のOCRテキストから成績表の情報を抽出して、必ずJSONのみで返してください。\n" +
          "ルール:\n" +
          "- 取れない項目は null\n" +
          "- 数字は可能なら number（例: 54.3）\n" +
          "- 科目は配列 subjects にまとめる（科目名、得点、偏差値、平均、順位）\n" +
          "- 余計な文章は出さない（JSONのみ）\n\n" +
          "返却JSONスキーマ（この形を守る）:\n" +
          `{
  "docType":"report",
  "student":{"name":null,"id":null},
  "test":{"name":null,"date":null},
  "overall":{"score":null,"deviation":null,"rank":null,"avg":null},
  "subjects":[{"name":"算数","score":null,"deviation":null,"avg":null,"rank":null}],
  "notes":[]
}\n\n` +
          "OCRテキスト:\n" +
          snippet,
      },
    ],
  });

  const out = (resp.output_text ?? "").trim();

  const parsed = safeParseJson<ReportJson>(out);
  if (!parsed || parsed.docType !== "report") {
    return {
      ok: false as const,
      reportJson: null as ReportJson | null,
      error: "JSONの解析に失敗（フォーマット不正）",
      raw: out,
    };
  }

  // 最低限の整形（subjects.nameが空なら弾くなど）
  if (!Array.isArray(parsed.subjects)) parsed.subjects = [];
  parsed.subjects = parsed.subjects
    .filter((s) => s && typeof s.name === "string" && s.name.trim().length > 0)
    .map((s) => ({
      name: s.name.trim(),
      score: typeof s.score === "number" ? s.score : null,
      deviation: typeof s.deviation === "number" ? s.deviation : null,
      avg: typeof s.avg === "number" ? s.avg : null,
      rank: typeof s.rank === "number" ? s.rank : null,
    }));

  return {
    ok: true as const,
    reportJson: parsed,
    raw: out, // デバッグ用（必要なければ後で消す）
  };
}

/* =========================
   成績表判定
========================= */
/** OCRテキストから「成績表っぽいか？」判定（ハード判定→LLM） */
async function judgeGradeReport(params: {
  filename: string;
  extractedText: string;
}) {
  const { filename, extractedText } = params;

  // 先頭+末尾（抜け道対策）
  const head = extractedText.slice(0, 3000);
  const tail = extractedText.slice(-3000);
  const snippet = `${head}\n...\n${tail}`;

  if (!snippet.trim()) {
    return {
      isGradeReport: false,
      confidence: 10,
      reason: "OCR結果がほぼ空でした（判定材料不足）",
    };
  }

  // -----------------------------
  // 0) ハード判定（強制false）
  // -----------------------------
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

  // -----------------------------
  // 1) 成績表っぽい “肯定根拠” が薄い場合はfalse寄り
  // -----------------------------
  const POSITIVE_HINTS = [
    /偏差値/,
    /順位/,
    /平均点|平均との差/,
    /得点|点数/,
    /正答率/,
    /判定|志望校判定/,
    /成績推移|推移|学習状況/,
    /科目|国語|算数|理科|社会/,
  ];

  const posCount = POSITIVE_HINTS.reduce((acc, re) => acc + (re.test(snippet) ? 1 : 0), 0);

  if (posCount < 2) {
    return {
      isGradeReport: false,
      confidence: 70,
      reason:
        "偏差値/順位/平均点/判定など成績表の典型語が少なく、成績表の根拠が弱い",
    };
  }

  // -----------------------------
  // 2) LLMで最終判定（補助）
  // -----------------------------
  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content:
          "あなたは学習塾の業務システムで、PDFの内容が『成績表（テスト結果/成績推移/偏差値/順位など）』かどうかを判定する担当です。" +
          "推測しすぎず、本文から根拠語を示して判定してください。",
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
          "成績表の根拠は『偏差値』『順位』『平均点』『正答率』『判定』『成績推移』などの語や、科目別スコア一覧があること。\n" +
          "\n\n" +
          "これが『成績表（模試・テスト結果・成績推移）』に該当するかを判定し、必ず次のJSONのみを返してください。\n" +
          '{ "isGradeReport": boolean, "confidence": number, "reason": string }\n' +
          "confidenceは0〜100。reasonは1〜2文で、根拠語を含めてください。",
      },
    ],
  });

  const txt = (resp.output_text ?? "").trim();

  try {
    const obj = JSON.parse(txt);
    return {
      isGradeReport: Boolean(obj.isGradeReport),
      confidence: Number.isFinite(obj.confidence)
        ? Math.max(0, Math.min(100, Number(obj.confidence)))
        : 50,
      reason: typeof obj.reason === "string" ? obj.reason : "理由の取得に失敗しました",
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
   集計（analysis）  ★ここが②の正しい置き場所：POSTの外
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

  // 平均偏差値が低い順（nullは最後）
  subjects.sort((a, b) => {
    const av = a.avgDeviation ?? 9999;
    const bv = b.avgDeviation ?? 9999;
    return av - bv;
  });

  const weakest = subjects[0]?.avgDeviation != null ? subjects[0] : null;

  return { subjects, weakest };
}

function analyzeYearlyReportJson(yearly: any) {
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
   Handler
========================= */
export async function POST(req: NextRequest) {
  try {
    const fd = await req.formData();

    /* ---------- UIからの入力 ---------- */

    // 単発：複数
    const singleFiles = fd.getAll("single").filter((v): v is File => v instanceof File);

    // 年間：1枚
    const yearlyFileRaw = fd.get("yearly");
    const yearlyFile = yearlyFileRaw instanceof File ? yearlyFileRaw : null;

    // 講師設定
    const tone = fd.get("tone")?.toString() ?? "gentle";
    const target = fd.get("target")?.toString() ?? "student";

    let focus: string[] = [];
    try {
      focus = JSON.parse(fd.get("focus")?.toString() ?? "[]");
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

        let reportJson: ReportJson | null = null;
        let reportJsonMeta: { ok: boolean; error: string | null } | null = null;

        if (gradeCheck.isGradeReport) {
          const extracted = await extractReportJsonFromText({
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
    let yearlyGradeCheck:
      | { isGradeReport: boolean; confidence: number; reason: string }
      | null = null;
    let yearlyReportJson: ReportJson | null = null;
    let yearlyReportJsonMeta: { ok: boolean; error: string | null } | null = null;

    if (uploadedYearly) {
      try {
        yearlyOcrText = await ocrPdfFromStorage({
          bucket,
          path: uploadedYearly.path,
          filename: uploadedYearly.name,
        });

        yearlyGradeCheck = await judgeGradeReport({
          filename: uploadedYearly.name,
          extractedText: yearlyOcrText,
        });

        if (yearlyOcrText && yearlyGradeCheck?.isGradeReport) {
          const extracted = await extractReportJsonFromText({
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
        yearlyOcrText = null;
        yearlyGradeCheck = {
          isGradeReport: false,
          confidence: 0,
          reason: "OCRに失敗したため判定できません",
        };
      }
    }

    /* ---------- ②: JSONを使った分析集計（returnの直前で計算） ---------- */
    const singleJsonItems = (singleOcrResults ?? []).map((x: any) => ({
      filename: x.name, // ★ x.filename ではなく x.name
      reportJson: x.reportJson,
    }));

    const singleAnalysis = analyzeSinglesReportJson(singleJsonItems);
    const yearlyAnalysis = analyzeYearlyReportJson(yearlyReportJson);

    /* ---------- Response ---------- */
    return NextResponse.json({
      summary: `単発=${uploadedSingles.length}枚 / 年間=${uploadedYearly ? "あり" : "なし"}`,
      files: {
        singles: uploadedSingles,
        yearly: uploadedYearly,
      },
      ocr: {
        singles: singleOcrResults,
        yearly: yearlyOcrText,
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

      // ★追加：分析結果（UIで表示できる）
      analysis: {
        singles: singleAnalysis,
        yearly: yearlyAnalysis,
      },
    });
  } catch (e: any) {
    return new NextResponse(e?.message ?? "Server error", { status: 500 });
  }
}
