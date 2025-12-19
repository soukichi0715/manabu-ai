import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function AnalyzePage() {
  const cookieName = process.env.TEACHER_LOGIN_COOKIE ?? "teacher_session";
  const has = (await cookies()).get(cookieName)?.value;

  if (!has) redirect("/login/teacher");

  return (
    <div>
      <h1>分析モード</h1>
      {/* ここに既存UI */}
    </div>
  );
}
