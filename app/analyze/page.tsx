import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/**
 * 分析モード（講師用）
 * ・単発テスト／年間推移の2アップロード
 * ・講師の視点選択（トーン・ミス傾向など）
 * ・MVP段階ではUI確定を最優先
 */
export default async function AnalyzePage() {
  // --- 講師ログインチェック ---
  const cookieName = process.env.TEACHER_LOGIN_COOKIE ?? "teacher_session";
  const hasSession = (await cookies()).get(cookieName)?.value;
  if (!hasSession) redirect("/login/teacher");

  return (
    <div style={{ maxWidth: 1000, margin: "40px auto", padding: "0 16px" }}>
      {/* =====================
          ヘッダー
      ===================== */}
      <header style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 26, marginBottom: 8 }}>分析モード</h1>
        <p style={{ color: "#555" }}>
          成績データと講師の視点をもとに、課題と次の打ち手を整理します。
        </p>
      </header>

      {/* =====================
          ① 成績データのアップロード
      ===================== */}
      <section style={sectionStyle}>
        <h2 style={sectionTitle}>① 成績データのアップロード</h2>

        {/* 単発テスト */}
        <div style={boxStyle}>
          <h3 style={boxTitle}>今回のテスト（単発分析）</h3>
          <p style={boxDesc}>
            育成テスト・公開模試など、1回分の成績表PDF
          </p>
          <input
  id="singleTestPdf"
  type="file"
  accept="application/pdf"
  style={{ display: "none" }}
/>

<label htmlFor="singleTestPdf" style={buttonStyle}>
  PDFを選択
</label>

        </div>

        {/* 年間推移 */}
        <div style={{ ...boxStyle, marginTop: 16 }}>
          <h3 style={boxTitle}>1年分の成績（推移分析）</h3>
          <p style={boxDesc}>
            過去1年分の成績表PDFをまとめてアップロード
          </p>
         <input
  id="yearlyPdf"
  type="file"
  accept="application/pdf"
  multiple
  style={{ display: "none" }}
/>

<label htmlFor="yearlyPdf" style={buttonStyle}>
  PDFをまとめて選択
</label>

        </div>
      </section>

      {/* =====================
          ② 講師の視点・選択肢
      ===================== */}
      <section style={sectionStyle}>
        <h2 style={sectionTitle}>② 講師の視点設定</h2>

        {/* 分析スタンス */}
        <fieldset style={fieldSetStyle}>
          <legend style={legendStyle}>分析スタンス（トーン）</legend>
          <label><input type="radio" name="tone" /> 厳しめ</label><br />
          <label><input type="radio" name="tone" defaultChecked /> バランス</label><br />
          <label><input type="radio" name="tone" /> 励まし重視</label>
        </fieldset>

        {/* 指導視点 */}
        <fieldset style={fieldSetStyle}>
          <legend style={legendStyle}>指導視点（原因の置き所）</legend>
          <label><input type="radio" name="focus" /> 本人要因</label><br />
          <label><input type="radio" name="focus" defaultChecked /> 学習方法</label><br />
          <label><input type="radio" name="focus" /> 環境要因</label>
        </fieldset>

        {/* 時間軸 */}
        <fieldset style={fieldSetStyle}>
          <legend style={legendStyle}>合格戦略（時間軸）</legend>
          <label><input type="radio" name="term" /> 短期（次回テスト）</label><br />
          <label><input type="radio" name="term" defaultChecked /> 中期（学期・講習）</label><br />
          <label><input type="radio" name="term" /> 長期（入試逆算）</label>
        </fieldset>

        {/* ミス傾向 */}
        <fieldset style={fieldSetStyle}>
          <legend style={legendStyle}>ミス傾向（複数選択）</legend>
          <label><input type="checkbox" /> 計算ミス</label><br />
          <label><input type="checkbox" /> 条件整理ミス</label><br />
          <label><input type="checkbox" /> 読み違い</label><br />
          <label><input type="checkbox" /> 立式ミス</label><br />
          <label><input type="checkbox" /> 時間配分ミス</label><br />
          <label><input type="checkbox" /> ケアレス混在</label>
        </fieldset>

        {/* 介入レベル */}
        <fieldset style={fieldSetStyle}>
          <legend style={legendStyle}>介入レベル</legend>
          <label><input type="radio" name="intervention" /> 最小</label><br />
          <label><input type="radio" name="intervention" defaultChecked /> 標準</label><br />
          <label><input type="radio" name="intervention" /> 徹底</label>
        </fieldset>

        {/* 出力対象 */}
        <fieldset style={fieldSetStyle}>
          <legend style={legendStyle}>出力対象</legend>
          <label><input type="checkbox" defaultChecked /> 講師用</label><br />
          <label><input type="checkbox" defaultChecked /> 保護者用</label><br />
          <label><input type="checkbox" /> 生徒用</label><br />
          <label><input type="checkbox" /> 面談用まとめ</label>
        </fieldset>
      </section>

      {/* =====================
          ③ 実行
      ===================== */}
      <section style={{ marginTop: 32, textAlign: "center" }}>
        <button
          style={{
            padding: "14px 28px",
            fontSize: 16,
            background: "#2563eb",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          この設定で分析する
        </button>
      </section>
    </div>
  );
}

/* =====================
   スタイル定義
===================== */

const sectionStyle: React.CSSProperties = {
  marginTop: 32,
  padding: 20,
  border: "1px solid #ddd",
  borderRadius: 12,
};

const sectionTitle: React.CSSProperties = {
  fontSize: 18,
  marginBottom: 16,
};

const boxStyle: React.CSSProperties = {
  padding: 16,
  border: "1px solid #ccc",
  borderRadius: 10,
  background: "#fafafa",
};

const boxTitle: React.CSSProperties = {
  fontSize: 15,
  marginBottom: 4,
};

const boxDesc: React.CSSProperties = {
  fontSize: 13,
  color: "#666",
  marginBottom: 8,
};

const fieldSetStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 12,
  border: "1px solid #ccc",
  borderRadius: 8,
};

const legendStyle: React.CSSProperties = {
  fontWeight: "bold",
  fontSize: 14,
};

const buttonStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "10px 16px",
  background: "#e5e7eb",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
};
