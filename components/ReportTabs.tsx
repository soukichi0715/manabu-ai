"use client";
import { useState } from "react";

type Props = {
  reports: {
    menndan_1min: { title: string; body: string; bullets?: string[]; tags?: string[] };
    child_simple: { title: string; body: string; action?: string };
    parent_handout: { title: string; summary: string; points: string[]; nextAction: string };
  };
};

export default function ReportTabs({ reports }: Props) {
  const [tab, setTab] = useState<"menndan" | "parent" | "child">("menndan");

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => setTab("menndan")}>面談用</button>
        <button onClick={() => setTab("parent")}>配布用</button>
        <button onClick={() => setTab("child")}>子ども向け</button>
      </div>

      {tab === "menndan" && (
        <section>
          <h3>{reports.menndan_1min.title}</h3>
          <p style={{ whiteSpace: "pre-wrap" }}>{reports.menndan_1min.body}</p>
          {reports.menndan_1min.bullets?.length ? (
            <ul>
              {reports.menndan_1min.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          ) : null}
        </section>
      )}

      {tab === "parent" && (
        <section>
          <h3>{reports.parent_handout.title}</h3>
          <p>{reports.parent_handout.summary}</p>
          <ul>
            {reports.parent_handout.points.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          <p><b>次回まで：</b>{reports.parent_handout.nextAction}</p>
        </section>
      )}

      {tab === "child" && (
        <section>
          <h3>{reports.child_simple.title}</h3>
          <p>{reports.child_simple.body}</p>
          {reports.child_simple.action ? (
            <p><b>今日のミッション：</b>{reports.child_simple.action}</p>
          ) : null}
        </section>
      )}
    </div>
  );
}
