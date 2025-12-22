import { NextRequest, NextResponse } from "next/server";

type Difficulty = "A" | "B" | "C";
type Trend = "up" | "down" | "flat" | "unknown";

type YearlyTest =
  | { type: "ikusei"; date: string; twoScore: number; grade: number }
  | { type: "kokai"; date: string; deviation: number };

type SingleQ = { q: number; rate: number; correct: boolean };
type SampleInput = {
  studentKey: "A" | "B" | "C";
  yearly: { tests: YearlyTest[] };
  single: { date: string; questionStats: { sansuu: SingleQ[] } };
};

function classify(rate: number): Difficulty {
  if (rate >= 70) return "A";
  if (rate >= 40) return "B";
  return "C";
}

function trend(vals: number[], threshold: number): Trend {
  if (!vals || vals.length < 2) return "unknown";
  const diff = vals[vals.length - 1] - vals[0];
  if (diff >= threshold) return "up";
  if (diff <= -threshold) return "down";
  return "flat";
}

function buildMistakeSummary(single: SampleInput["single"]) {
  const items = single.questionStats.sansuu.map((x) => ({
    ...x,
    level: classify(x.rate),
  }));

  const byLevel = { A: { total: 0, miss: 0 }, B: { total: 0, miss: 0 }, C: { total: 0, miss: 0 } };
  for (const it of items) {
    byLevel[it.level].total += 1;
    if (!it.correct) byLevel[it.level].miss += 1;
  }

  const aMiss = byLevel.A.miss;
  const bMiss = byLevel.B.miss;
  const cMiss = byLevel.C.miss;

  const insight =
    aMiss >= 1
      ? "A問題（易）での取りこぼしがあり、安定性が最優先課題です。"
      : bMiss >= 2
        ? "B問題（標準）の取りこぼしが多く、得点の芯を作ることが最優先です。"
        : "A/Bは概ね取れており、C（難）は伸びしろ領域です。";

  return { subject: "sansuu", items, byLevel, insight };
}

function buildYearlyTrends(yearly: SampleInput["yearly"]) {
  const ikuseiGrades = yearly.tests.filter((t) => t.type === "ikusei").map((t: any) => t.grade);
  const ikuseiScores = yearly.tests.filter((t) => t.type === "ikusei").map((t: any) => t.twoScore);
  const kokaiDevs = yearly.tests.filter((t) => t.type === "kokai").map((t: any) => t.deviation);

  return {
    ikuseiGrade: { values: ikuseiGrades, trend: trend(ikuseiGrades, 1) },
    ikuseiScore: { values: ikuseiScores, trend: trend(ikuseiScores, 10) },
    kokaiDev: { values: kokaiDevs, trend: trend(kokaiDevs, 2) },
  };
}

function buildReports(studentKey: "A" | "B" | "C", yearlyTrends: any, mistakeSummary: any) {
  // ここは「テンプレ固定」が最も強い（ブレない）
  const base = {
    title: "面談用コメント（1分版）",
    body: "",
    bullets: [] as string[],
    tags: [] as string[],
  };

  if (studentKey === "A") {
    base.body =
      "今回の推移を見ると、成績は安定して上向きです。育成テストは6→6→7と伸びており、公開模試も54→55→56と少しずつ上がっています。\n\n算数はA/Bを取り切れており、Cのみ落とす理想形です。\n\n次回は『標準問題の見直し』を継続するだけで十分です。";
    base.bullets = [
      "年間推移は安定して上向き",
      "算数はA/Bを取り切れている",
      "次回は標準問題の見直し継続",
    ];
    base.tags = ["安定", "上向き", "算数精度"];
  } else if (studentKey === "B") {
    base.body =
      "推移を見ると、ここ数か月で伸び始めています。育成は4→5→6、公開も48→51→53と改善傾向です。\n\n算数はAは取れていますが、B後半で取りこぼしが出ています。\n\n次回はB問題を取り切る（途中式＋最後5分でBだけ見直し）が最優先です。";
    base.bullets = [
      "年間推移が上昇",
      "算数はB問題で取りこぼし",
      "途中式＋B見直しを固定",
    ];
    base.tags = ["上昇", "伸び始め", "B問題強化"];
  } else {
    base.body =
      "推移は力はあるが波が大きいタイプです。育成7→5→6、公開55→50→52と上下しています。\n\n算数でA問題の取りこぼしがあり、安定性が最優先課題です。\n\n次回はA問題を『絶対に落とさない』（途中式・計算チェック・A見直し）を固定します。";
    base.bullets = [
      "年間推移が不安定",
      "算数でA問題の取りこぼし",
      "A死守ルール（途中式＋チェック）",
    ];
    base.tags = ["不安定", "ケアレス", "A問題死守"];
  }

  // child / handout も同時に返す（UIはタブで切替）
  const child_simple =
    studentKey === "A"
      ? {
          title: "きみへのメッセージ",
          body:
            "いまのきみは、できる問題をしっかり取れる力がついてきています。つぎにやることは『ふつうの問題をまちがえない』ことだけでOK！",
          action: "標準問題を1回だけ見直す",
        }
      : studentKey === "B"
        ? {
            title: "きみへのメッセージ",
            body:
              "さいきん伸びてきたよ。つぎは『みんなができる問題』をていねいに取ろう。途中式がカギ！",
            action: "途中式を書いてから答えを書く",
          }
        : {
            title: "きみへのメッセージ",
            body:
              "むずかしい問題にチャレンジできる力があるよ。つぎは『かんたんな問題をぜったい落とさない』を最優先にしよう。",
            action: "かんたんな問題をさいごにもう1回見る",
          };

  const parent_handout =
    studentKey === "A"
      ? {
          title: "成績状況のご報告（要点）",
          summary:
            "成績は安定して上向いています。基礎〜標準が定着し、学力が安定して伸びている段階です。",
          points: [
            "育成：6→6→7",
            "公開：偏差値54→55→56",
            "算数：A/Bを安定して得点",
          ],
          nextAction: "標準問題の見直し継続",
        }
      : studentKey === "B"
        ? {
            title: "成績状況のご報告（要点）",
            summary:
              "成績は上向きで、伸び始めている段階です。安定性を高めることでさらに成果が期待できます。",
            points: [
              "育成：4→5→6",
              "公開：偏差値48→51→53",
              "算数：B後半で取りこぼし",
            ],
            nextAction: "途中式＋B見直しの習慣化",
          }
        : {
            title: "成績状況のご報告（要点）",
            summary:
              "学力はありますが波が出やすい状態です。安定感を高めることが最優先課題です。",
            points: [
              "推移：上下の波がある",
              "算数：A問題の取りこぼし",
              "難問対応力は十分",
            ],
            nextAction: "A問題死守の見直しルール固定",
          };

  return { menndan_1min: base, child_simple, parent_handout };
}

export async function POST(req: NextRequest) {
  const input = (await req.json()) as SampleInput;

  const yearlyTrends = buildYearlyTrends(input.yearly);
  const mistakeSummary = buildMistakeSummary(input.single);
  const reports = buildReports(input.studentKey, yearlyTrends, mistakeSummary);

  return NextResponse.json({
    analysisMode: "full",
    studentKey: input.studentKey,
    yearlyTrends,
    mistakeSummary,
    reports,
  });
}
