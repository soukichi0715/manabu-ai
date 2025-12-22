"use client";
import { useState } from "react";
import ReportTabs from "@/components/ReportTabs";

const samples = {
  A: {
    studentKey: "A",
    yearly: { tests: [
      { type: "ikusei", date: "2025-04-01", twoScore: 260, grade: 6 },
      { type: "ikusei", date: "2025-05-01", twoScore: 265, grade: 6 },
      { type: "ikusei", date: "2025-06-01", twoScore: 268, grade: 7 },
      { type: "kokai",  date: "2025-07-01", deviation: 54 },
      { type: "kokai",  date: "2025-09-01", deviation: 55 },
      { type: "kokai",  date: "2025-11-01", deviation: 56 }
    ]},
    single: { date: "2025-12-20", questionStats: { sansuu: [
      { q: 1, rate: 82, correct: true },
      { q: 2, rate: 74, correct: true },
      { q: 3, rate: 55, correct: true },
      { q: 4, rate: 42, correct: true },
      { q: 5, rate: 25, correct: false }
    ]}}
  },
  B: {
    studentKey: "B",
    yearly: { tests: [
      { type: "ikusei", date: "2025-04-01", twoScore: 235, grade: 4 },
      { type: "ikusei", date: "2025-05-01", twoScore: 245, grade: 5 },
      { type: "ikusei", date: "2025-06-01", twoScore: 255, grade: 6 },
      { type: "kokai",  date: "2025-07-01", deviation: 48 },
      { type: "kokai",  date: "2025-09-01", deviation: 51 },
      { type: "kokai",  date: "2025-11-01", deviation: 53 }
    ]},
    single: { date: "2025-12-20", questionStats: { sansuu: [
      { q: 1, rate: 85, correct: true },
      { q: 2, rate: 72, correct: true },
      { q: 3, rate: 58, correct: true },
      { q: 4, rate: 46, correct: false },
      { q: 5, rate: 33, correct: false }
    ]}}
  },
  C: {
    studentKey: "C",
    yearly: { tests: [
      { type: "ikusei", date: "2025-04-01", twoScore: 270, grade: 7 },
      { type: "ikusei", date: "2025-05-01", twoScore: 250, grade: 5 },
      { type: "ikusei", date: "2025-06-01", twoScore: 265, grade: 6 },
      { type: "kokai",  date: "2025-07-01", deviation: 55 },
      { type: "kokai",  date: "2025-09-01", deviation: 50 },
      { type: "kokai",  date: "2025-11-01", deviation: 52 }
    ]},
    single: { date: "2025-12-20", questionStats: { sansuu: [
      { q: 1, rate: 88, correct: false },
      { q: 2, rate: 76, correct: true },
      { q: 3, rate: 60, correct: false },
      { q: 4, rate: 44, correct: false },
      { q: 5, rate: 28, correct: false }
    ]}}
  }
} as const;

export default function SampleAnalyzePage() {
  const [student, setStudent] = useState<"A"|"B"|"C">("A");
  const [data, setData] = useState<any>(null);

  async function run() {
    setData(null);
    const r = await fetch("/api/analyze/sample", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(samples[student]),
    });
    setData(await r.json());
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <h2>サンプル分析</h2>

      <div style={{ display: "flex", gap: 8 }}>
        <select value={student} onChange={(e) => setStudent(e.target.value as any)}>
          <option value="A">生徒A</option>
          <option value="B">生徒B</option>
          <option value="C">生徒C</option>
        </select>
        <button onClick={run}>このサンプルで分析</button>
      </div>

      {data?.reports ? <ReportTabs reports={data.reports} /> : null}

      {data ? (
        <details>
          <summary>生データ（debug）</summary>
          <pre>{JSON.stringify(data, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}
