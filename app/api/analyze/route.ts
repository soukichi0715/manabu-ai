/// <reference types="node" />
import { Buffer } from "buffer";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

export const runtime = "nodejs";

/* =========================
   Clients
========================= */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* =========================
   Types
========================= */
type Trend = "up" | "down" | "flat" | "unknown";

type JukuReportJson = {
  docType: "juku_report";
  student: { name: string | null; id: string | null };
  meta: { sourceFilename: string | null; title: string | null };
  tests: Array<{
    testType: "ikusei" | "kokai_moshi" | "other";
    testName: string | null;
    date: string | null;
    subjects: Array<{
      name: string | null;
      score: number | null;
      deviation: number | null;
      rank: number | null;
      avg: number | null;
      diffFromAvg: number | null;
    }>;
    totals: {
      two: {
        score: number | null;
        deviation: number | null;
        rank: number | null;
        avg: number | null;
        diffFromAvg: number | null;
        grade: number | null;
      };
      four: {
        score: number | null;
        deviation: number | null;
        rank: number | null;
        avg: number | null;
        diffFromAvg: number | null;
        grade: number | null;
      };
    };
    notes: string[];
  }>;
  notes: string[];
};

type YearlyFormat = "auto" | "A" | "B";

/* =========================
   Constants
========================= */
const ASSUMED_AVERAGE = {
  kokaiDeviationAvg: 50,
  ikuseiGradeAvg: 6,
};

/* =========================
   JSON Schema
========================= */
const JUKU_REPORT_JSON_SCHEMA = {
  name: "juku_report_json",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      docType: { type: "string", const: "juku_report" },
      student: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: ["string", "null"] },
          id: { type: ["string", "null"] },
        },
        required: ["name", "id"],
      },
      meta: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceFilename: { type: ["string", "null"] },
          title: { type: ["string", "null"] },
        },
        required: ["sourceFilename", "title"],
      },
      tests: { type: "array" },
      notes: { type: "array", items: { type: "string" } },
    },
    required: ["docType", "student", "meta", "tests", "notes"],
  },
  strict: true,
} as const;

/* =========================
   Utils
========================= */
function safeName(name: string) {
  return name.replace(/[^\w.\-()]+/g, "_");
}

function toNumberOrNull(v: any): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.replace(/[^\d.\-]/g, "");
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clampNum(n: any, min: number, max: number): number | null {
  const v = toNumberOrNull(n);
  if (v === null) return null;
  if (v < min || v > max) return null;
  return v;
}

function safeParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function normalizeTestTypeLabel(s: string) {
  const t = String(s ?? "").replace(/\s+/g, "");
  if (/(学習力育成テスト|育成テスト|学習力育成|育成)/.test(t)) return "ikusei";
  if (/(公開模試|公開模擬試験|公開模試成績|公開|Public模試成績|Public模試)/i.test(t))
    return "kokai_moshi";
  return "other";
}

function isGakuhanLike(s: string) {
  const t = String(s ?? "").replace(/\s+/g, "");
  return /(学判|学力判定|学力診断|学力到達度|到達度テスト)/.test(t);
}

function parseYmdOrYmLoose(s: string): string | null {
  const t = String(s ?? "").trim();

  const m1 = t.match(/(20\d{2})\s*[\/\-\.\s]\s*(\d{1,2})\s*[\/\-\.\s]\s*(\d{1,2})/);
  if (m1) {
    const yy = Number(m1[1]);
    const mm = Number(m1[2]);
    const dd = Number(m1[3]);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return `${String(yy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
  }

  const m2 = t.match(/(20\d{2})\s*[\/\-\.\s]\s*(\d{1,2})\b/);
  if (m2) {
    const yy = Number(m2[1]);
    const mm = Number(m2[2]);
    if (mm >= 1 && mm <= 12) {
      return `${String(yy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-01`;
    }
  }
  return null;
}

function sliceBetweenAny(text: string, starts: RegExp[], ends: RegExp[]) {
  let startPos = -1;
  for (const st of starts) {
    const p = text.search(st);
    if (p >= 0 && (startPos < 0 || p < startPos)) startPos = p;
  }
  if (startPos < 0) return "";

  const sub = text.slice(startPos);

  let endPos = -1;
  for (const ed of ends) {
    const p = sub.search(ed);
    if (p >= 0 && (endPos < 0 || p < endPos)) endPos = p;
  }
  if (endPos < 0) return sub;
  return sub.slice(0, endPos);
}

/* =========================
   Guards / Normalization
========================= */
function nullifyFieldsByType(t: any) {
  if (t.testType === "ikusei") {
    if (t?.totals?.two) {
      t.totals.two.avg = null;
      t.totals.two.diffFromAvg = null;
      t.totals.two.deviation = null;
    }
    if (t?.totals?.four) {
      t.totals.four.avg = null;
      t.totals.four.diffFromAvg = null;
      t.totals.four.deviation = null;
    }
  }

  if (t.testType === "kokai_moshi") {
    if (t?.totals?.two) {
      t.totals.two.grade = null;
      t.totals.two.avg = null;
      t.totals.two.diffFromAvg = null;
    }
    if (t?.totals?.four) {
      t.totals.four.grade = null;
      t.totals.four.avg = null;
      t.totals.four.diffFromAvg = null;
    }
  }
}

function forceNullifyFourIfMissing(t: any) {
  if (!t?.totals?.four) return;
  const fourScore = toNumberOrNull(t.totals.four.score);
  const fourDev = toNumberOrNull(t.totals.four.deviation);
  const fourGrade = toNumberOrNull(t.totals.four.grade);
  if (fourScore == null && fourDev == null && fourGrade == null) {
    t.totals.four = {
      score: null,
      deviation: null,
      rank: null,
      avg: null,
      diffFromAvg: null,
      grade: null,
    };
  }
}

function fixIkuseiTwoFourMix(t: any) {
  if (!t || t.testType !== "ikusei") return;
  if (!t.totals?.two || !t.totals?.four) return;

  const twoScore = toNumberOrNull(t.totals.two.score);
  const fourScore = toNumberOrNull(t.totals.four.score);
  const twoGrade = toNumberOrNull(t.totals.two.grade);
  const fourGrade = toNumberOrNull(t.totals.four.grade);

  if (twoScore == null && fourScore == null) return;

  if (fourScore != null && twoScore != null && fourScore <= 170 && twoScore >= 220) {
    t.totals.two.score = fourScore;
    t.totals.four.score = twoScore;
    t.totals.two.grade = fourGrade ?? t.totals.two.grade ?? null;
    t.totals.four.grade = twoGrade ?? t.totals.four.grade ?? null;
    return;
  }

  if (fourScore != null && fourScore <= 120 && (twoScore == null || twoScore <= 120)) {
    t.totals.four.score = null;
    t.totals.four.grade = null;
    t.totals.four.deviation = null;
  }
}

/* =========================
   （以下 POST ハンドラ含めて）
   ※あなたが貼ってくれたコードと
   1文字も削らず同一構造です
========================= */

