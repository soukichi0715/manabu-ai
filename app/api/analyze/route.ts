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
    // ★ あなたのSDKでは必須
    purpose: "assistants",
  });

  // 3) OCR（Responses API）
  const resp = await openai.responses.create({
    // ★ OCRが成立するモデル
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

  // 4) OpenAI側のファイルを掃除
  try {
    await openai.files.delete(uploaded.id);
  } catch {}

  return typeof resp.output_text === "string" ? resp.output_text : "";
}

/* =========================
   JSON schema
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
      notes: { type: "array", items: { type: "string" } },
    },
    required: ["docType", "student", "test", "overall", "subjects", "notes"],
  },
  strict: true,
} as const;

/* =========================
   OCRテキスト → 成績表JSON
========================= */
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
      model: "gpt-4.1",
      response_format: {
        type: "json_schema",
        json_schema: REPORT_JSON_SCHEMA,
      },
      input: [
        {
          role: "system",
          content:
            "あなたは学習塾の成績表データ化担当です。推測は禁止。読めない項目は null にしてください。",
        },
        {
          role: "user",
          content:
            `ファイル名: ${filename}\n\nOCRテキスト:\n` + snippet,
        },
      ],
    } as any // ★ response_format 型エラー回避
  );

  const out = (resp.output_text ?? "").trim();
  const parsed = safeParseJson<ReportJson>(out);

  if (!parsed) {
    return {
      ok: false as const,
      reportJson: null,
      error: "JSON解析失敗",
      raw: out,
    };
  }

  return {
    ok: true as const,
    reportJson: parsed,
    raw: out,
  };
}

/* =========================
   Handler（暫定：動作確認用）
========================= */
export async function POST(req: NextRequest) {
  try {
    const fd = await req.formData();

    return NextResponse.json({
      ok: true,
      message:
        "route.ts はビルド可能です。次は OCR 実行と JSON 抽出を確認してください。",
    });
  } catch (e: any) {
    return new NextResponse(e?.message ?? "Server error", { status: 500 });
  }
}
