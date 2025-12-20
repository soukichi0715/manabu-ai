import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import AnalyzeClient from "./AnalyzeClient";

export default async function AnalyzePage() {
  const cookieName = process.env.TEACHER_LOGIN_COOKIE ?? "teacher_session";
  const hasSession = (await cookies()).get(cookieName)?.value;
  if (!hasSession) redirect("/login/teacher");

  return <AnalyzeClient />;
}
