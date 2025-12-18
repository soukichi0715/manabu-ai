import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

/* ===============================
   OpenAI
================================ */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

/* ===============================
   Supabase（Service Role）
================================ */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/* ===============================
   まなぶ先生AI SYSTEM PROMPT（全文）
================================ */
const SYSTEM_PROMPT = `
あなたは中学受験算数のプロ講師「まなぶ先生AI」です。

◆最重要の価値観
・「正しく解く力」よりも、「自分で考える力」を育てることを最優先にする。
・ミスは責めるものではなく、「次に伸びるヒント」として扱う。

◆話し方・トーン
・基本はやさしくフランク（優しさ7：厳しさ3）。
・ただし、改善すべき点や甘えは、はっきりと言語化して伝える。
・相手が小学生のとき：ややくだけた言葉で、短く分かりやすく。
・相手が保護者のとき：です・ます調で、論理的かつ安心感のある説明にする。

◆相手の前提（必ず意識する）
・中学受験を考えている小学生、またはその保護者。
・成績や偏差値が安定しない、ケアレスミスが多い、勉強法が分からない等の悩みを持っている。
・質問文から「学年」「志望校レベル」「塾の有無」などが読み取れれば、それを前提に話す。
・情報が足りない場合は、最初に1〜2個だけ補足質問をしてよいが、
　必ず「今できるアドバイス」も同時に出す。

◆指導スタイル
1. まず現状を整理して言語化する  
2. 複数の原因候補を提示する（Aタイプ／Bタイプなど）  
3. 原因ごとの具体的対策を出す（行動レベル）  
4. 思考のプロセスを教える（考え方の手順）  
5. 最後に前向きな一言を添える（理由付き）

◆フォーマット
【1. 今の状況の整理】
【2. 考えられる原因】
【3. 今日からできる対策】
【4. ひとことメッセージ】

以上を必ず守り、
「子どもと保護者の味方」でありつつ、
「伸ばすために言うべきことは言うプロ講師」
として振る舞ってください。
`;

/* ===============================
   util
================================ */
function jsonError(message: string, status = 400, extra?: any) {
  return NextResponse.json({ ok: false, message, ...extra }, { status });
}

/* ===============================
   POST /api/chat
================================ */
export async function POST(req: NextRequest) {
  /* -------- ① JSONを安全に読む -------- */
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body");
  }

  const message =
    typeof body?.message === "string" ? body.message.trim() : "";

  if (!message) {
    return jsonError("message is required");
  }

  /* -------- ② Supabase用データ（本番補完） -------- */
  const insertRow = {
    user_id: body?.user_id ?? "web",
    test_id: body?.test_id ?? "ed9ba4f3-fdca-48a7-9d1e-6287cf505c98",
    subject: body?.subject ?? "未分類",               // NOT NULL
    qid: body?.qid ?? `web-${crypto.randomUUID()}`,   // NOT NULL
    is_correct: false,                                // NOT NULL
    question: message,
    answer: null,
  };

  /* -------- ③ Supabase insert -------- */
  const { data, error } = await supabase
    .from("responses")
    .insert([insertRow])
    .select();

  if (error) {
    console.error("Supabase insert error:", error);
    return NextResponse.json(
      { ok: false, where: "supabase_insert", error },
      { status: 500 }
    );
  }

  /* -------- ④ OpenAI（まなぶ先生AI） -------- */
  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: message },
    ],
  });

  const reply =
    completion.choices[0]?.message?.content ??
    "ごめんね、うまく整理できなかった。もう一度教えて。";

  await supabase
    .from("responses")
    .update({ answer: reply })
    .eq("id", data?.[0]?.id);
    
  /* -------- ⑤ 返却 -------- */
  return NextResponse.json({
    ok: true,
    reply,
    log_id: data?.[0]?.id,
    received: body, // ★追加：Webから何が届いたか確認用（デバッグが終わったら消す）
  });
}
