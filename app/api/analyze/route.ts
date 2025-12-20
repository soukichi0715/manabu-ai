import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

export const runtime = "nodejs";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function safeName(name: string) {
  return name.replace(/[^\w.\-()]+/g, "_");
}

/** Supabase上のPDFをOCRしてテキスト化 */
async function ocrPdfFromStorage(params: {
  bucket: string;
  path: string;
  filename: string;
}) {
  const { bucket, path, filename } = params;

  // 1) SupabaseからPDF取得
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
    file: await OpenAI.toFile(buf, filename, {
      type: "application/pdf",
    }),
    purpose: "assistants",
  });

  // 3) OCR
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
              "このPDFはスキャン画像の成績表です。OCRして、表の項目名と数値を漏れなくテキスト化してください。" +
              "未記入は「空欄」と書き、推測で埋めないでください。",
          },
        ],
      },
    ],
  });

  return resp.output_text ?? "";
}

export async function POST(req: NextRequest) {
  try {
    const fd = await req.formData();

    /** 単発：複数枚 */
    const singleFiles = fd
      .getAll("single")
      .filter((v): v is File => v instanceof File);

    /** 年間：1枚 */
    const yearlyFile = fd.get("yearly");
    const yearly = yearlyFile instanceof File ? yearlyFile : null;

    if (singleFiles.length === 0 && !yearly) {
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

    /** アップロード */
    const uploadedSingles = [];
    for (const f of singleFiles) uploadedSingles.push(await upload(f));

    const uploadedYearly = yearly ? await upload(yearly) : null;

    /** OCR（Vercel対策で上限） */
    const MAX_SINGLE_OCR = 5;
    const singleTargets = uploadedSingles.slice(0, MAX_SINGLE_OCR);

    const singleOcrResults = [];
    for (const f of singleTargets) {
      try {
        const text = await ocrPdfFromStorage({
          bucket,
          path: f.path,
          filename: f.name,
        });
        singleOcrResults.push({ ...f, ok: true, text });
      } catch (e: any) {
        singleOcrResults.push({
          ...f,
          ok: false,
          error: e?.message ?? "OCR error",
        });
      }
    }

    const yearlyOcrText = uploadedYearly
      ? await ocrPdfFromStorage({
          bucket,
          path: uploadedYearly.path,
          filename: uploadedYearly.name,
        })
      : null;

    return NextResponse.json({
      summary: `単発=${uploadedSingles.length}枚 / 年間=${uploadedYearly ? "あり" : "なし"}`,
      files: {
        singles: uploadedSingles,
        yearly: uploadedYearly,
      },
      ocr: {
        singles: singleOcrResults,
        yearly: yearlyOcrText,
        note:
          uploadedSingles.length > MAX_SINGLE_OCR
            ? `単発PDFが多いため、先頭${MAX_SINGLE_OCR}枚のみOCRしました`
            : null,
      },
    });
  } catch (e: any) {
    return new NextResponse(e?.message ?? "Server error", { status: 500 });
  }
}
