"use client";

import type { FlowSnapshot } from "../lib/snapshot.ts";

export default function FlowStatus({ snapshot }: { snapshot: FlowSnapshot }) {
  const s = snapshot.state;
  return (
    <section className="panel">
      <h2>Flow Status</h2>
      <div className="kv">
        <div className="k">flow_id</div>
        <div className="v">
          <code>{snapshot.flow_id}</code>
        </div>
        <div className="k">goal</div>
        <div className="v">{snapshot.goal || <em className="empty">—</em>}</div>
        <div className="k">phase</div>
        <div className="v">
          <span className={`badge phase-${s.phase}`}>{s.phase}</span>
        </div>
        <div className="k">current_milestone</div>
        <div className="v">{s.current_milestone ?? <em className="empty">—</em>}</div>
        <div className="k">current_feature</div>
        <div className="v">{s.current_feature ?? <em className="empty">—</em>}</div>
        <div className="k">current_step</div>
        <div className="v">{s.current_step ?? <em className="empty">—</em>}</div>
        <div className="k">corrective_attempts</div>
        <div className="v">
          {Object.keys(s.corrective_attempts).length === 0 ? (
            <em className="empty">none</em>
          ) : (
            <code>{JSON.stringify(s.corrective_attempts)}</code>
          )}
        </div>
        <div className="k">counters</div>
        <div className="v">
          <code>
            llm={s.counters.llm_calls} tok_in={s.counters.tokens_in} tok_out={s.counters.tokens_out} usd={s.counters.usd_spent.toFixed(4)}
          </code>
        </div>
        <div className="k">started_at</div>
        <div className="v">
          <code>{s.started_at}</code>
        </div>
        <div className="k">updated_at</div>
        <div className="v">
          <code>{s.updated_at}</code>
        </div>
      </div>
    </section>
  );
}
