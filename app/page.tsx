// app/page.tsx
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function Home() {
  const supabase = createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle(); // single()より安全

  // profiles未作成・取得失敗時はログインへ戻す（またはエラー画面）
  if (error || !profile?.role) {
    redirect("/login");
  }

  if (profile.role === "teacher") redirect("/analyze");
  redirect("/report");
}

