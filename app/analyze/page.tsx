import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function AnalyzePage() {
  const cookieName = process.env.TEACHER_LOGIN_COOKIE ?? "teacher_session";
  const has = (await cookies()).get(cookieName)?.value;

  if (!has) redirect("/login/teacher");

  return (
    <div style={{ maxWidth: 980, margin: "40px auto", padding: "0 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1 style={{ fontSize: 24, margin: 0 }}>分析モード</h1>
          <p style={{ margin: "8px 0 0", color: "#666" }}>
            成績PDF（スキャン）を読み込み、課題と次の打ち手を自動で整理します
          </p>
        </div>
        <a href="/login" style={{ color: "#666", textDecoration: "underline" }}>
          ログイン選択へ
        </a>
      </header>

      {/* ① アップロード */}
      <section style={{ marginTop: 24, padding: 16, border: "1px solid #ddd", borderRadius: 12 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>PDFアップロード</h2>
        <p style={{ margin: "8px 0 12px", color: "#666" }}>
          例：育成テスト／公開模試の成績表（PDF）
        </p>

        <div
          style={{
            border: "2px dashed #bbb",
            borderRadius: 12,
            padding: 24,
            textAlign: "center",
            color: "#666",
            background: "#fafafa",
          }}
        >
          ここにPDFをドラッグ＆ドロップ<br />
          または <button style={{ marginTop: 12 }}>ファイルを選択</button>
        </div>

        <p style={{ marginTop: 12, fontSize: 12, color: "#888" }}>
          ※MVPではまず1種類のPDF形式から対応します（順次拡張）
        </p>
      </section>

      {/* ② 解析履歴 */}
      <section style={{ marginTop: 24, padding: 16, border: "1px solid #ddd", borderRadius: 12 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>解析履歴（デモ）</h2>

        <table style={{ width: "100%", marginTop: 12, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#666" }}>
              <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>日時</th>
              <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>生徒ID</th>
              <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>種別</th>
              <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>状態</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2" }}>2025/12/19 21:10</td>
              <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2" }}>S123456</td>
              <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2" }}>育成テスト</td>
              <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2" }}>完了</td>
            </tr>
            <tr>
              <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2" }}>2025/12/19 20:30</td>
              <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2" }}>S999001</td>
              <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2" }}>公開模試</td>
              <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2" }}>解析中</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* ③ 結果プレビュー */}
      <section style={{ marginTop: 24, padding: 16, border: "1px solid #ddd", borderRadius: 12 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>解析結果プレビュー（デモ）</h2>
        <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
          <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 10 }}>
            <strong>今回の要点</strong>
            <ul style={{ margin: "8px 0 0" }}>
              <li>計算は安定、文章題で条件整理ミスが多い</li>
              <li>割合（基準量の切替）で失点が集中</li>
            </ul>
          </div>

          <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 10 }}>
            <strong>次回までの優先課題（Top3）</strong>
            <ol style={{ margin: "8px 0 0" }}>
              <li>割合：基準量の書き分け（線分図テンプレ）</li>
              <li>文章題：問い→条件→式 の順番固定</li>
              <li>計算：符号/単位の見直しチェック導入</li>
            </ol>
          </div>

          <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 10 }}>
            <strong>保護者への一言（自動生成・デモ）</strong>
            <p style={{ margin: "8px 0 0", color: "#333" }}>
              今回は「条件整理」が原因の失点が目立ちました。解き方の知識というより、
              文章題の読み取り順を固定すると安定します。次回は割合の“基準量”の書き分けを最優先にします。
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}