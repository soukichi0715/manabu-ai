// lib/ocrPostProcess.ts

export type TestType = "ikusei" | "kokai_moshi" | "other";

export type Totals = {
  two: { score: number | null; deviation?: number | null; rank?: number | null; avg?: number | null; diffFromAvg?: number | null; grade: number | null };
  four: { score: number | null; deviation?: number | null; rank?: number | null; avg?: number | null; diffFromAvg?: number | null; grade: number | null };
};

export type Test = {
  testType: TestType;
  testName: string | null;
  date: string | null; // YYYY-MM-DD
  subjects: any[]; // 既存構造を壊さないため any のまま（必要なら後で型を詰める）
  totals: Totals;
  notes: string[];
};

export type ReportJson = {
  docType: string;
  student: { name: string | null; id: string | null };
  meta: { sourceFilename: string | null; title: string | null };
  tests: Test[];
  notes: string[];
};

export type StudentType = "two" | "four";
export type AnalysisMode = "full" | "yearly-only";

export type PostProcessResult = {
  analysisMode: AnalysisMode;
  studentType: StudentType;
  isTwoSubjectStudent: boolean;
  tests: Test[];
  warnings: string[];
};

/**
 * 育成テストの「表示評価」は 1〜3のみ（保護者向け）という仕様に合わせ、
 * OCRが 4以上を拾っても 3 に丸める。
 * ついでに 1/2 が出たら警告ログに残す（表示は仕様どおり 3 にしてもOK運用ならここで変更可能）
 */
export function normalizeIkuseiGrade(grade: number | null, warnings: string[], ctx: { testName?: string | null; date?: string | null }) {
  if (grade == null) return null;

  // 数字っぽいが異常な値
  if (!Number.isFinite(grade)) return null;

  // 1,2 を拾うのも誤読の可能性が高い：警告だけ残す
  if (grade === 1 || grade === 2) {
    warnings.push(`育成評価が ${grade} を検出（誤読の可能性）。${ctx.testName ?? ""} ${ctx.date ?? ""}`.trim());
    // 「表示は3」運用に寄せるなら 3 にする：
    return 3;
  }

  // 3はOK
  if (grade === 3) return 3;

  // 4以上は仕様上出ないので 3 に丸める
  if (grade >= 4) {
    warnings.push(`育成評価が ${grade} を検出→3に正規化。${ctx.testName ?? ""} ${ctx.date ?? ""}`.trim());
    return 3;
  }

  // 0やマイナスは破棄
  warnings.push(`育成評価が異常値 ${grade} を検出→null。${ctx.testName ?? ""} ${ctx.date ?? ""}`.trim());
  return null;
}

/**
 * 2科生判定（年間データだけでも動くようにしてある）
 * - 公開模試が4科しか無いのは普通に起こるので、育成テストに重みを置く
 * - 育成テストの two.score が継続して存在し、four.score が欠ける/異常なら 2科寄り
 * - 逆に four.score が継続して存在し、two.score が空なら 4科寄り
 *
 * ※あなたのデータでは「two.score と four.score が両方いる」こともあるので、
 *   “片方が恒常的に空”を強く判定条件にする
 */
export function detectStudentType(tests: Test[], warnings: string[]): { studentType: StudentType; isTwoSubjectStudent: boolean } {
  const ikusei = tests.filter(t => t.testType === "ikusei");

  const twoPresent = ikusei.filter(t => (t.totals?.two?.score ?? null) != null).length;
  const fourPresent = ikusei.filter(t => (t.totals?.four?.score ?? null) != null).length;

  // 判定用のしきい値（安全側）
  const n = ikusei.length;
  if (n === 0) return { studentType: "four", isTwoSubjectStudent: false };

  // “ほぼ全部”片方が空なら確定
  const almostAll = Math.max(1, Math.floor(n * 0.7));

  // twoが多く、fourが極端に少ない → 2科生
  if (twoPresent >= almostAll && fourPresent <= Math.floor(n * 0.3)) {
    return { studentType: "two", isTwoSubjectStudent: true };
  }

  // fourが多く、twoが極端に少ない → 4科生
  if (fourPresent >= almostAll && twoPresent <= Math.floor(n * 0.3)) {
    return { studentType: "four", isTwoSubjectStudent: false };
  }

  // ここは“混在”扱い：OCR由来で両方拾ってる可能性があるので警告
  warnings.push(`2科/4科判定が混在（育成: twoPresent=${twoPresent}, fourPresent=${fourPresent}, n=${n}）。暫定的に4科扱い。`);
  return { studentType: "four", isTwoSubjectStudent: false };
}

/**
 * totalsのスコア妥当性チェック（オプション）
 * - 変な桁（例：221など）が入る場合の検知だけして warning に積む
 * - ここでは破壊的に消さない（あなたの「勝手に削らない」方針に合わせる）
 */
export function sanityCheckScores(tests: Test[], warnings: string[]) {
  for (const t of tests) {
    const two = t.totals?.two?.score ?? null;
    const four = t.totals?.four?.score ?? null;

    if (two != null && (two < 0 || two > 300)) {
      warnings.push(`score(two)が範囲外の可能性: ${two} (${t.testName ?? ""} ${t.date ?? ""})`.trim());
    }
    if (four != null && (four < 0 || four > 500)) {
      warnings.push(`score(four)が範囲外の可能性: ${four} (${t.testName ?? ""} ${t.date ?? ""})`.trim());
    }
  }
}

/**
 * メイン後処理
 * - 単発が無ければ yearly-only
 * - 育成評価を 3 までに正規化
 * - 2科/4科判定
 */
export function postProcessReport(params: {
  yearlyReportJson: ReportJson | null;
  hasSinglePdf: boolean; // 単発PDFが入っているか
}): PostProcessResult {
  const warnings: string[] = [];
  const tests: Test[] = (params.yearlyReportJson?.tests ?? []).map(t => ({ ...t }));

  // 育成評価を正規化（two/four 両方）
  for (const t of tests) {
    if (t.testType === "ikusei") {
      t.totals.two.grade = normalizeIkuseiGrade(t.totals.two.grade, warnings, { testName: t.testName, date: t.date });
      t.totals.four.grade = normalizeIkuseiGrade(t.totals.four.grade, warnings, { testName: t.testName, date: t.date });
    }
  }

  sanityCheckScores(tests, warnings);

  const { studentType, isTwoSubjectStudent } = detectStudentType(tests, warnings);

  const analysisMode: AnalysisMode = params.hasSinglePdf ? "full" : "yearly-only";
  if (!params.hasSinglePdf) {
    warnings.push("単発PDFが未投入のため、分析モードは yearly-only（年間推移の参考分析）です。");
  }

  return {
    analysisMode,
    studentType,
    isTwoSubjectStudent,
    tests,
    warnings,
  };
}
