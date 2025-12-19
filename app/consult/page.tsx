"use client";

import { useEffect, useRef, useState, FormEvent } from "react";
import Image from "next/image";
import Link from "next/link";

type ChatMessage = { role: "user" | "assistant"; content: string };

function getOrCreateDeviceId() {
  const key = "manabu_device_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `dev-${Date.now()}`;
    localStorage.setItem(key, id);
  }
  return id;
}

export default function ConsultPage() {
  const [input, setInput] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setDeviceId(getOrCreateDeviceId());
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function handleSubmit(e?: FormEvent) {
    if (e) e.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage: ChatMessage = { role: "user", content: input.trim() };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "consult",
          message: userMessage.content,
          subject: "算数",
          qid:
            typeof crypto !== "undefined" && crypto.randomUUID
              ? `web-${crypto.randomUUID()}`
              : `web-${Date.now()}`,
          user_id: deviceId || "web",
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data?.message ?? "API error");

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply ?? "エラーが発生しました。" },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            "通信エラーが発生しました。ネットワーク環境を確認して、もう一度試してください。",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 flex justify-center px-2 py-4">
      <div className="flex w-full max-w-6xl gap-4">
        <aside className="hidden lg:flex w-1/3 items-center justify-center">
          <div className="flex flex-col items-center text-center space-y-2">
            <div className="w-40 h-40 relative rounded-full overflow-hidden border border-slate-200 shadow-md bg-white">
              <Image
                src="/manabu1.jpg"
                alt="まなぶ先生AI"
                fill
                sizes="160px"
                className="object-cover"
              />
            </div>
            <p className="text-sm font-semibold text-slate-800">
              中学受験算数プロ講師
            </p>
            <p className="text-xs text-slate-500 px-4">
              「正しく解く力」よりも「自分で考える力」を大切にする、
              あなた専用のAI先生です。
            </p>
          </div>
        </aside>

        <div className="flex flex-col w-full lg:w-2/3 bg-white border border-slate-200 rounded-2xl shadow-md overflow-hidden">
          <header className="px-5 py-3 border-b border-slate-200 bg-slate-50/80 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <h1 className="text-xl md:text-2xl font-bold text-slate-900">
                相談モード
              </h1>
              <Link
                href="/analyze"
                className="text-xs md:text-sm px-3 py-1 rounded-lg border border-slate-300 bg-white text-slate-700"
              >
                分析へ
              </Link>
              <span className="ml-auto text-[10px] md:text-xs text-slate-400">
                ID: {deviceId ? deviceId.slice(0, 8) + "…" : "生成中…"}
              </span>
            </div>
            <p className="text-xs md:text-sm text-slate-500 mt-1">
              中学受験算数の相談をどうぞ。質問を送ると「優しさ7：厳しさ3」で返します。
            </p>
          </header>

          <section className="flex-1 flex flex-col px-3 md:px-4 pt-3 pb-2 max-h-[70vh] overflow-y-auto bg-slate-50">
            {messages.length === 0 && !loading && (
              <div className="text-xs md:text-sm text-slate-400 mt-2">
                例：
                <br />
                ・「算数の勉強法を教えて」
                <br />
                ・「割合の文章題でよく間違えます」
                <br />
                ・「偏差値が50前後を行ったり来たりして不安です」
              </div>
            )}

            <div className="space-y-3 md:space-y-4">
              {messages.map((m, idx) => {
                const isUser = m.role === "user";
                return (
                  <div
                    key={idx}
                    className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                  >
                    {!isUser && (
                      <div className="mr-2 mt-5 hidden sm:flex">
                        <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center text-xs font-bold">
                          ま
                        </div>
                      </div>
                    )}

                    <div
                      className={`max-w-[80%] md:max-w-[75%] px-3 py-2 md:px-4 md:py-3 rounded-2xl text-xs md:text-sm leading-relaxed whitespace-pre-wrap ${
                        isUser
                          ? "bg-blue-500 text-white rounded-br-sm shadow-sm"
                          : "bg-white text-slate-900 rounded-bl-sm border border-slate-200 shadow-sm"
                      }`}
                    >
                      <span className="block text-[10px] md:text-[11px] mb-1 opacity-80 tracking-wide">
                        {isUser ? "あなた" : "まなぶ先生AI"}
                      </span>
                      {m.content}
                    </div>

                    {isUser && <div className="w-8 ml-2" />}
                  </div>
                );
              })}

              {loading && (
                <div className="flex justify-start">
                  <div className="mr-2 mt-3 hidden sm:flex">
                    <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center text-xs font-bold">
                      ま
                    </div>
                  </div>
                  <div className="flex items-center gap-2 px-3 py-2 md:px-4 md:py-3 bg-white border border-slate-200 rounded-2xl shadow-sm text-xs md:text-sm text-slate-600">
                    <div className="w-6 h-6 relative">
                      <Image
                        src="/loading.gif"
                        alt="読み込み中"
                        fill
                        sizes="24px"
                        className="object-contain"
                      />
                    </div>
                    <span>考え中です… 少しお待ちください。</span>
                  </div>
                </div>
              )}

              <div ref={endRef} />
            </div>
          </section>

          <form
            onSubmit={handleSubmit}
            className="border-t border-slate-200 bg-white px-3 md:px-4 py-2 md:py-3 flex gap-2 items-end"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={2}
              className="flex-1 resize-none rounded-xl border border-slate-300 px-3 py-2 text-xs md:text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 bg-slate-50"
              placeholder="Enterで送信（Shift+Enterで改行）"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
            />

            <button
              type="submit"
              disabled={loading || !deviceId}
              className="px-4 py-2 rounded-xl bg-blue-600 text-white text-xs md:text-sm font-semibold disabled:bg-slate-400 disabled:cursor-not-allowed shadow-sm"
            >
              {loading ? "送信中…" : "送信"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
