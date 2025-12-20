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

  return resp.output_text ?? "";
}

/** OCRテキストから「成績表っぽいか？」判定 */
async function judgeGradeReport(params: {
  filename: string;
  extractedText: string;
}) {
  const { filename, extractedText } = params;

  // 長すぎるとコスト＆時間が増えるので、冒頭中心に切る（成績表なら上部に情報が出がち）
  const snippet = extractedText.slice(0, 3500);

  // からっぽなら即「不明（false寄り）」扱い
  if (!snippet.trim()) {
    return {
      isGradeReport: false,
      confidence: 10,
      reason: "OCR結果がほぼ空でした（判定材料不足）",
    };
  }

  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content:
          "あなたは学習塾の業務システムで、PDFの内容が『成績表（テスト結果/成績推移/偏差値/順位など）』かどうかを判定する担当です。" +
          "推測しすぎず、本文から根拠を示して判定してください。",
      },
      {
        role: "user",
        content:
          "次のOCRテキストは、アップロードされたPDFの内容です。\n" +
          "ファイル名: " +
          filename +
          "\n\n" +
          "OCRテキスト（先頭抜粋）:\n" +
          snippet +
          "※重要：次のような文書は『成績表』ではありません：入学試験/入試/試験問題/問題用紙/解答用紙/解答欄/配点/大問小問/注意事項/『記入しないこと』があるもの。\n" +
"それらが見えたら isGradeReport=false にしてください。\n" +
"成績表の根拠は『偏差値』『順位』『平均点』『正答率』『判定』『成績推移』などの語や、科目別スコア一覧があること。\n" +
"\n\n" +
          "これが『成績表（模試・テスト結果・成績推移）』に該当するかを判定し、必ず次のJSONのみを返してください。\n" +
          '{ "isGradeReport": boolean, "confidence": number, "reason": string }\n' +
          "confidenceは0〜100。reasonは1〜2文で、根拠語を含めてください。",
      },
    ],
  });

  // JSONだけ返させてるが、万一崩れた時に備えて保険パース
  const txt = (resp.output_text ?? "").trim();

  try {
    const obj = JSON.parse(txt);
    return {
      isGradeReport: Boolean(obj.isGradeReport),
      confidence: Number.isFinite(obj.confidence) ? Math.max(0, Math.min(100, Number(obj.confidence))) : 50,
      reason: typeof obj.reason === "string" ? obj.reason : "理由の取得に失敗しました",
    };
  } catch {
    // JSONが崩れた場合のフォールバック（最低限）
    return {
      isGradeReport: false,
      confidence: 30,
      reason: "判定JSONの解析に失敗（フォーマット不正）",
    };
  }
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

    /* ---------- OCR + 成績表判定 ---------- */

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

        singleOcrResults.push({
          ...f,
          ok: true,
          text,
          gradeCheck, // ★追加：成績表判定
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
      } catch (e: any) {
        yearlyOcrText = null;
        yearlyGradeCheck = {
          isGradeReport: false,
          confidence: 0,
          reason: "OCRに失敗したため判定できません",
        };
      }
    }

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
        yearlyGradeCheck, // ★追加：年間の成績表判定
        note:
          uploadedSingles.length > MAX_SINGLE_OCR
            ? `単発PDFが多いため、先頭${MAX_SINGLE_OCR}枚のみOCRしました`
            : null,
      },

      // UIで選んだ設定（次フェーズで分析生成に使う）
      selections: {
        tone,
        focus,
        target,
      },
    });
  } catch (e: any) {
    return new NextResponse(e?.message ?? "Server error", { status: 500 });
  }
}
