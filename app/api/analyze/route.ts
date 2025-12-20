import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// supabase-js を使うので Node runtime を明示（Vercelで安定）
export const runtime = "nodejs";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

function safeName(name: string) {
  return name.replace(/[^\w.\-()]+/g, "_");
}

export async function POST(req: NextRequest) {
  try {
    const fd = await req.formData();

    const single = fd.get("single");
    const yearly = fd.getAll("yearly");

    if (!(single instanceof File) && yearly.length === 0) {
      return new NextResponse("PDFがありません。", { status: 400 });
    }

    const bucket = process.env.SUPABASE_PDF_BUCKET ?? "report-pdfs";
    const baseDir = `analyze/${Date.now()}`;

    async function upload(file: File) {
      const arrayBuffer = await file.arrayBuffer();
      const path = `${baseDir}/${safeName(file.name)}`;

      const { error } = await supabase.storage.from(bucket).upload(path, arrayBuffer, {
        contentType: file.type || "application/pdf",
        upsert: false,
      });
      if (error) throw new Error(`Supabase upload failed: ${error.message}`);

      return { path, name: file.name, size: file.size };
    }

    const uploadedSingle = single instanceof File ? await upload(single) : undefined;

    const uploadedYearly: { path: string; name: string; size: number }[] = [];
    for (const v of yearly) {
      if (v instanceof File) uploadedYearly.push(await upload(v));
    }

    // MVP：仮結果
    return NextResponse.json({
      summary: `【MVP結果】単発=${uploadedSingle ? "あり" : "なし"} / 年間=${uploadedYearly.length}件`,
      nextActions: ["次はPDFの中身抽出を実装して実分析へ"],
      files: { single: uploadedSingle, yearly: uploadedYearly },
      selections: {},
    });
  } catch (e: any) {
    return new NextResponse(e?.message ?? "Server error", { status: 500 });
  }
}
