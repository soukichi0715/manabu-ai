import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const { id, password } = await req.json();

  const ok =
    id === process.env.TEACHER_LOGIN_ID &&
    password === process.env.TEACHER_LOGIN_PASSWORD;

  if (!ok) {
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(process.env.TEACHER_LOGIN_COOKIE ?? "teacher_session", "1", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8, // 8時間
  });
  return res;
}