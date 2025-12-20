import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

export const runtime = "nodejs";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function safeName(name: string) {
  return name.replace(/[^\w.\-()]+/g, "_");
}

export async function POST(req: NextRequest) {
  try {
    const fd = await req.formData();

    const single = fd.get("single");
    const yearly = fd.getAll("yearly");

    // selections（フロントから来る想定。来なければデフォルト）
    const tone = String(fd.get("tone") ?? "balance");
    const focus = String(fd.get("focus") ?? "method");
    const term = String(fd.get("term") ?? "mid");

    let missTypes: string[] = [];
    let targets: string[] = ["coach", "parent"];
    try {
      missTypes = JSON.parse(String(fd.get("missTypes") ?? "[]"));
    } catch {}
    const intervention = String(fd.get("intervention") ?? "std");
    try {
      targets = JSON.parse(String(fd.get("targets") ?? '["coach","parent"]'));
    } catch {}

    if (!(single instanceof File) && yearly.length === 0) {
      return new NextResponse("PDFがありません。", { status: 400 });
    }

    const bucket = process.env.SUPABASE_PDF_BUCKET ?? "report-pdfs";
    const baseDir = `analyze/${crypto.randomUUID()}`;

    async function upload(file: File) {
      const arrayBuffer = await file.arrayBuffer();
      const path = `${baseDir}/${safeName(file.name)}`;

      const { error } = await supabase.storage.from(bucket).upload(path, arrayBuffer, {
        contentType: file.type || "application/pdf",
        upsert: true,
      });
      if (error) throw new Error(`Supabase upload failed: ${error.message}`);

      return { path, name: file.name, size: file.size };
    }

    // ①アップロード
    const uploadedSingle = single instanceof File ? await upload(single) : null;

    const uploadedYearly: { path: string; name: string; size: number }[] = [];
    for (const v of yearly) {
      if (v instanceof File) uploadedYearly.push(await upload(v));
    }

    // ②単発の署名URL（デバッグ用：あってもなくてもOK）
    let singleSignedUrl: string | null = null;
    if (uploadedSingle) {
      const { data, error } = await supabase
        .storage.from(bucket)
        .createSignedUrl(uploadedSingle.path, 60 * 10);
      if (!error) singleSignedUrl = data.signedUrl;
    }

    // ③OCR抽出（まずは単発だけ：年間は後で回す）
    let extractedText: string | null = null;

    if (uploadedSingle) {
  // 1) supabase storage からPDFを取得
  const { data: pdfBlob, error: dlErr } = await supabase.storage
    .from(bucket)
    .download(uploadedSingle.path);

  if (dlErr || !pdfBlob) throw new Error(`Supabase download failed: ${dlErr?.message}`);

  // 2) OpenAI Files にアップロードして file_id を作る
  // Node環境: Blob -> ArrayBuffer -> Buffer
  const ab = await pdfBlob.arrayBuffer();
  const buf = Buffer.from(ab);

  const uploaded = await openai.files.create({
    file: await OpenAI.toFile(buf, uploadedSingle.name, { type: "application/pdf" }),
    purpose: "assistants",
  });

  // 3) Responses API に file_id を渡してOCR
  const resp = await openai.responses.create({
    model: "gpt-4.1-mini", // まずはここで安定させる（後で上げる）
    input: [
      {
        role: "user",
        content: [
          { type: "input_file", file_id: uploaded.id },
          {
            type: "input_text",
            text:
              "このPDFはスキャン画像の成績表です。OCRして、表の項目名と数値を漏れなくテキスト化してください。判読不能は[判読不能]と書き、推測で埋めないでください。",
          },
        ],
      },
    ],
  });

  extractedText = resp.output_text ?? null;
}


    const nextActions = [
      "OCR結果が出たら、次は『偏差値/得点/単元/正誤』をJSON化して分析ロジックに繋げる",
      "年間PDFは同様にOCR→集計して、推移（落ち始め/伸びた単元）を出す",
      "講師選択肢（トーン/対象）で文章の言い方を出し分ける",
    ];

    return NextResponse.json({
      summary: `【OCR付きMVP】単発=${uploadedSingle ? "あり" : "なし"} / 年間=${uploadedYearly.length}件`,
      nextActions,
      files: {
        single: uploadedSingle
          ? { ...uploadedSingle, signedUrl: singleSignedUrl }
          : null,
        yearly: uploadedYearly,
      },
      selections: { tone, focus, term, missTypes, intervention, targets },
      extractedText,
    });
  } catch (e: any) {
    return new NextResponse(e?.message ?? "Server error", { status: 500 });
  }
}
