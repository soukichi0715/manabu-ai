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
type ReportJson = {
  docType: "report";
  student: { name: string | null; id: string | null };
  test: { name: string | null; date: string | null };
  overall: {
    score: number | null;
    deviation: number | null;
    rank: number | null;
    avg: number | null;
  };
  subjects: {
    name: string;
    score: number | null;
    deviation: number | null;
    avg: number | null;
    rank: number | null;
  }[];
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
   ★追加：JSON Schema定義（response_format用）
========================= */
const REPORT_JSON_SCHEMA = {
  name: "ReportJson",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      docType: { type: "string", enum: ["report"] },
      student: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: ["string", "null"] },
          id: { type: ["string", "null"] },
        },
        required: ["name", "id"],
      },
      test: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: ["string", "null"] },
          date: { type: ["string", "null"] },
        },
        required: ["name", "date"],
      },
      overall: {
        type: "object",
        additionalProperties: false,
        properties: {
          score: { type: ["number", "null"] },
          deviation: { type: ["number", "null"] },
          rank: { type: ["number", "null"] },
          avg: { type: ["number", "null"] },
        },
        required: ["score", "deviation", "rank", "avg"],
      },
      subjects: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            score: { type: ["number", "null"] },
            deviation: { type: ["number", "null"] },
            avg: { type: ["number", "null"] },
            rank: { type: ["number", "null"] },
          },
          required: ["name", "score", "deviation", "avg", "rank"],
        },
      },
      notes: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["docType", "student", "test", "overall", "subjects", "notes"],
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

/** OCRテキストから成績表JSONを抽出（MVP） */
async function extractReportJsonFromText(params: {
  filename: string;
  extractedText: string;
}) {
  const { filename, extractedText } = params;

  const head = extractedText.slice(0, 4000);
  const tail = extractedText.slice(-4000);
  const snippet = `${head}\n...\n${tail}`;

  const resp = await openai.responses.create(
    {
      model: "gpt-4.1-mini",
      response_format: {
        type: "json_schema",
        json_schema: REPORT_JSON_SCHEMA,
      },
      input: [
        {
          role: "system",
          content:
            "あなたは学習塾の成績表データ化担当です。OCRテキストから成績表の数値を構造化JSONにします。" +
            "推測は禁止。見えない/不明はnullにしてください。日本語を尊重し、科目名は「国語/算数/理科/社会」を優先してください。" +
            "この帳票では『偏差値』ではなく『偏差』表記のことがあります。『偏差』を偏差値として扱ってください。",
        },
        {
          role: "user",
          content:
            `ファイル名: ${filename}\n\n` +
            "次のOCRテキストから成績表の情報を抽出してください。\n" +
            "ルール:\n" +
            "- 取れない項目は null\n" +
            "- 数字は可能なら number（例: 54.3）\n" +
            "- 科目は配列 subjects にまとめる（科目名、得点、偏差値、平均、順位）\n" +
            "- notes は補足を短く\n\n" +
            "OCRテキスト:\n" +
            snippet,
        },
      ],
    } as any
  );

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

  const POSITIVE_HINTS = [
    /偏差(値)?/,
    /順位/,
    /平均(点)?|平均との差/,
    /得点|点数/,
    /評価/,
    /4科目|2科目/,
    /公開模試|公開模擬試験/,
    /育成テスト|学習力育成テスト/,
    /合格力実践テスト/,
    /判定|志望校判定/,
    /成績推移|推移|学習状況/,
    /科目|国語|算数|理科|社会/,
  ];

  const posCount = POSITIVE_HINTS.reduce(
    (acc, re) => acc + (re.test(snippet) ? 1 : 0),
    0
  );

  if (posCount < 1) {
    return {
      isGradeReport: false,
      confidence: 70,
      reason:
        "偏差/得点/平均/評価/4科目2科目など成績表の根拠語が少なく、成績表の根拠が弱い",
    };
  }

  const resp = await openai.responses.create(
    {
      model: "gpt-4.1-mini",
      response_format: {
        type: "json_schema",
        json_schema: JUDGE_JSON_SCHEMA,
      },
      input: [
        {
          role: "system",
          content:
            "あなたは学習塾の業務システムで、PDFの内容が『成績表（偏差/得点/平均/評価など）』かどうかを判定する担当です。",
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
            "これらが本文に含まれる場合は isGradeReport=false にしてください。\n",
        },
      ],
    } as any
  );

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
  subjects.sort((a, b) => (a.avgDeviation ?? 9999) - (b.avgDeviation ?? 9999));
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
  singlesReportJson: Array<{ name: string; reportJson: ReportJson | null }>;
  yearlyReportJson: ReportJson | null;
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
      subjects: x.reportJson?.subjects ?? null,
      overall: x.reportJson?.overall ?? null,
      test: x.reportJson?.test ?? null,
    })),
    yearly: yearlyReportJson
      ? {
          subjects: yearlyReportJson.subjects,
          overall: yearlyReportJson.overall,
          test: yearlyReportJson.test,
        }
      : null,
  };

  const system = `
あなたは中学受験算数のプロ講師「まなぶ先生AI」です。
（中略：あなたの元のsystemのまま）
  `.trim();

  const user = `
以下は成績表JSONと集計結果です。
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
      .filter((v): v is File => v instanceof File);

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
    let yearlyOcrError: string | null = null; // ★追加
    let yearlyJudgeError: string | null = null; // ★追加

    let yearlyGradeCheck:
      | { isGradeReport: boolean; confidence: number; reason: string }
      | null = null;
    let yearlyReportJson: ReportJson | null = null;
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

    const singleJsonItems = (singleOcrResults ?? []).map((x: any) => ({
      filename: x.name,
      reportJson: x.reportJson,
    }));

    const singleAnalysis = analyzeSinglesReportJson(singleJsonItems);
    const yearlyAnalysis = analyzeYearlyReportJson(yearlyReportJson);

    const singlesReportJson = (singleOcrResults ?? []).map((x: any) => ({
      name: x.name,
      reportJson: x.reportJson as ReportJson | null,
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
        yearlyError: yearlyOcrError, // ★追加：これが出れば原因特定できる
        yearlyJudgeError, // ★追加
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
      commentary,
    });
  } catch (e: any) {
    console.error("[route POST fatal]", e);
    return new NextResponse(e?.message ?? "Server error", { status: 500 });
  }
}
