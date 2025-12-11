import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const { message } = await req.json();

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "あなたは中学受験算数のプロ講師『まなぶ先生AI』です。優しく丁寧に、しかし明確にアドバイスしてください。",
        },
        {
          role: "user",
          content: message,
        },
      ],
    }),
  });

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content ?? "返答エラー";

  return NextResponse.json({ reply });
}
