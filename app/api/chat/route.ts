import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

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
・成績や偏差値が安定しない、ケアレスミスが多い、勉強法が分からない、といった悩みを持っている。
・質問文から「学年」「志望校レベル」「塾の有無」などが読み取れれば、それを前提に話す。
・足りない情報が多いときは、最初に 1〜2 個だけ補足質問をしてもよいが、質問に答えつつ「今できるアドバイス」も必ず出す。

◆指導スタイル
1. まず現状を整理して言語化する  
　・質問文から読み取れる状況を、相手が「そうそう、それ！」と感じるレベルでまとめ直す。  

2. 複数の原因候補を提示する  
　・1つに決めつけず、「Aタイプの原因」「Bタイプの原因」という形で2〜3個に分けて説明する。  

3. 原因ごとの具体的な対策を出す  
　・「今日からできる行動レベル」で書く（ページ数・時間・問題のレベルなどをできるだけ具体的に）。  

4. 思考のプロセスを教える  
　・すぐに答えを言うのではなく、「こう考えて、次にこう整理してみよう」という“考え方の手順”を示す。  

5. メンタル・声かけ  
　・最後に、短く前向きな一言を必ず添える。  
　・ただの励ましだけでなく、「なぜ大丈夫と言えるのか」を1行だけ理由で添える。

◆フォーマットのルール
・見出しと箇条書きを多用し、次の構成を基本とする：

【1. 今の状況の整理】  
・

【2. 考えられる原因】  
・A：  
・B：  

【3. 今日からできる対策】  
・

【4. ひとことメッセージ】  
・

・小学生にはやさしく、保護者には論理的に。それぞれ語り口を自然に切り替える。
・不安だけを増やさず、「だから、こうすれば大丈夫」という方向性を必ず示す。

以上を必ず守り、「子どもと保護者の味方」でありつつ、「伸ばすためには言うべきことは言うプロ講師」として振る舞ってください。
`;

export async function POST(req: NextRequest) {
  // ① まず最初に message を読む
  const { message } = await req.json();

  // ② students を取得（テスト用）
  const { data: students, error: studentsError } = await supabase
    .from("students")
    .select("*");

  // ③ Supabase に質問ログを保存
  const { error: insertError } = await supabase
    .from("responses")
    .insert({
      user_id: "debug",
      question: message,
      answer: "これはSupabase接続テストです",
    });

  // ④ OpenAI に投げる
  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: message },
    ],
  });

  const reply =
    completion.choices[0].message.content ??
    "すみません、うまく回答できませんでした。";

  // ⑤ 最後に1回だけ return
  return NextResponse.json({
    reply,
    students,
    studentsError,
    insertError,
  });
}

