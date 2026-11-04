// Goals board and Goal page (plan §9, journeys doc §2.2–2.3).

import { useCallback, useEffect, useState } from "react";
import { levels } from "../../src/core/dag.ts";
import type { Goal, Plan, Step } from "../../src/protocol/goal.ts";
import type { GoalDetail, StepView, TimelineEntry } from "../../src/protocol/hub.ts";
import { api } from "./api.ts";

export function ago(now: number, at: number | undefined): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const COLUMNS: { title: string; states: Goal["state"][] }[] = [
  { title: "Backlog", states: ["backlog"] },
  { title: "Design", states: ["design"] },
  { title: "Awaiting approval", states: ["awaiting_approval"] },
  { title: "In progress", states: ["in_progress"] },
  { title: "Done", states: ["done"] },
];

export function GoalsBoard({ progress, onRefresh }: { progress: Record<string, { done: number; total: number; holders: string[] }>; onRefresh: () => void }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [title, setTitle] = useState("");
  const [repo, setRepo] = useState("");
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    api.goals().then(setGoals, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load, progress]);
  const now = Date.now();
  const recent = (g: Goal) => g.state !== "done" || now - g.updatedAt < 14 * 86_400_000;
  return (
    <section>
      <form
        className="newgoal"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          api.newGoal(title.trim(), repo.trim() || undefined).then(
            () => {
              setTitle("");
              setRepo("");
              load();
              onRefresh();
            },
            (err: Error) => setError(err.message),
          );
        }}
      >
        <input aria-label="New goal title" placeholder="New goal…" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input aria-label="Primary repo" placeholder="primary repo (optional)" value={repo} onChange={(e) => setRepo(e.target.value)} />
        <button type="submit">Create</button>
      </form>
      {error && <p className="error">{error}</p>}
      <div className="board">
        {COLUMNS.map((col) => {
          const items = goals.filter((g) => col.states.includes(g.state) && recent(g));
          return (
            <div key={col.title} className="column">
              <h3>
                {col.title} <span className="muted">{items.length}</span>
              </h3>
              {items.map((g) => {
                const p = progress[g.id];
                return (
                  <a key={g.id} className="card goalcard" href={`#/goal/${g.id}`}>
                    <div>
                      <strong>{g.id}</strong> {g.title}
                    </div>
                    <div className="muted small-text">
                      @{g.ownerId}
                      {g.primaryRepo ? ` · ${g.primaryRepo}` : ""} · {ago(now, g.updatedAt)}
                    </div>
                    {p && p.total > 0 && (
                      <div className="row">
                        <div className="bar">
                          <div style={{ width: `${(100 * p.done) / p.total}%` }} />
                        </div>
                        <span className="muted small-text">
                          {p.done}/{p.total}
                        </span>
                        <span className="muted small-text">{p.holders.map((h) => `@${h}`).join(" ")}</span>
                      </div>
                    )}
                  </a>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const BOX_W = 190;
const BOX_H = 52;
const COL_W = 240;
const ROW_H = 72;

function localId(id: string) {
  return id.slice(id.indexOf(".") + 1);
}

function Dag({ detail, selected, onSelect }: { detail: GoalDetail; selected?: string; onSelect: (id: string) => void }) {
  const visible = detail.steps.filter((s) => s.state !== "dropped");
  const lv = levels(visible);
  const pos = new Map<string, { x: number; y: number }>();
  lv.forEach((level, i) => level.forEach((s, j) => pos.set(s.id, { x: 10 + i * COL_W, y: 10 + j * ROW_H })));
  const width = 20 + Math.max(1, lv.length) * COL_W;
  const height = 20 + Math.max(1, ...lv.map((l) => l.length)) * ROW_H;
  return (
    <svg className="dag" width={width} height={height} role="img" aria-label="step graph">
      {visible.flatMap((s) =>
        s.deps.map((d) => {
          const a = pos.get(d);
          const b = pos.get(s.id);
          if (!a || !b) return null;
          const x1 = a.x + BOX_W;
          const y1 = a.y + BOX_H / 2;
          const x2 = b.x;
          const y2 = b.y + BOX_H / 2;
          return <path key={`${d}-${s.id}`} d={`M${x1},${y1} C${x1 + 30},${y1} ${x2 - 30},${y2} ${x2},${y2}`} className="edge" />;
        }),
      )}
      {visible.map((s) => {
        const p = pos.get(s.id) as { x: number; y: number };
        const h = detail.holders?.[s.id];
        const who = s.state === "claimed" || s.state === "paused" ? `@${s.holderUser ?? "?"}${h ? ` · ${h.state === "needs_you" ? `needs ${h.needs ?? "you"}` : h.state}` : ""}` : s.repo;
        return (
          <g key={s.id} transform={`translate(${p.x},${p.y})`} className={`node st-${s.state} ${selected === s.id ? "sel" : ""}`} onClick={() => onSelect(s.id)} data-step={s.id}>
            <rect width={BOX_W} height={BOX_H} rx={6} />
            <text x={8} y={19} className="nid">
              {localId(s.id)}
              {s.fixCycles ? ` ↻${s.fixCycles}` : ""}
            </text>
            <text x={BOX_W - 8} y={19} textAnchor="end" className="nstate">
              {s.state}
            </text>
            <text x={8} y={39} className="nwho">
              {(who || "").slice(0, 28)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function StepPanel({ id, now }: { id: string; now: number }) {
  const [view, setView] = useState<StepView>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setView(undefined);
    api.step(id).then(setView, (e: Error) => setError(e.message));
  }, [id]);
  if (error) return <div className="card panel error">{error}</div>;
  if (!view) return <div className="card panel muted">Loading…</div>;
  const { step, deps, notes } = view.context;
  const f = view.facts;
  return (
    <div className="card panel" aria-label="step details">
      <h3>
        {step.id} <span className="muted">· {step.kind} · {step.repo || "any repo"} · {step.state}</span>
      </h3>
      <p className="brief">{step.brief}</p>
      {step.holderUser && <p>Holder: @{step.holderUser}</p>}
      {step.summary && (
        <p>
          <strong>Summary:</strong> {step.summary} {step.mr && <code>{step.mr}</code>} {step.branch && <code>{step.branch}</code>}
        </p>
      )}
      {deps.length > 0 && <p className="muted">Depends on: {deps.map((d) => `${localId(d.id)} (${d.state})`).join(", ")}</p>}
      <table className="facts">
        <tbody>
          <tr>
            <td>turns</td>
            <td>{f.turns}</td>
            <td>human prompts</td>
            <td>{f.humanPrompts}</td>
            <td>nudges</td>
            <td>{f.nudges}</td>
          </tr>
          <tr>
            <td>waits</td>
            <td>
              {f.waits.count} ({f.waits.minutes} min)
            </td>
            <td>fix cycles</td>
            <td>{f.fixCycles}</td>
            <td>models</td>
            <td>{f.models.join(", ") || "—"}</td>
          </tr>
        </tbody>
      </table>
      {f.holders.length > 0 && <p className="muted small-text">Held by: {f.holders.map((h) => `@${h.user} ${ago(now, h.from)} ago`).join(" → ")}</p>}
      {notes.length > 0 && (
        <>
          <h4>Notes</h4>
          <ul className="notes">
            {notes.map((n) => (
              <li key={n.id}>
                <strong>@{n.user}</strong> {n.text} <span className="age">{ago(now, n.at)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {step.state === "ready" && <code className="hint">mesh run {step.repo || "<repo>"} --step {step.id}</code>}
      {step.state === "paused" && <code className="hint">mesh take {step.id}</code>}
    </div>
  );
}

function planDiff(a: Plan | undefined, b: Plan) {
  const before = new Map((a?.steps ?? []).map((s) => [s.id, JSON.stringify(s)]));
  const after = new Map(b.steps.map((s) => [s.id, JSON.stringify(s)]));
  return {
    added: [...after.keys()].filter((k) => !before.has(k)),
    removed: [...before.keys()].filter((k) => !after.has(k)),
    changed: [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)),
  };
}

function DesignTab({ detail, onDecide }: { detail: GoalDetail; onDecide: (kind: "approve" | "revise", comment: string) => void }) {
  const [comment, setComment] = useState("");
  const plans = detail.plans;
  const pending = plans.filter((p) => p.decision === "pending").at(-1);
  const now = Date.now();
  return (
    <div>
      {plans.length === 0 && <p className="muted">No plan proposed yet. The design session proposes one with mesh_plan.</p>}
      {pending && (
        <div className="card decide">
          <p>
            <strong>Plan v{pending.version}</strong> awaits a decision ({pending.steps.length} steps, proposed by @{pending.proposedBy} {ago(now, pending.proposedAt)} ago).
          </p>
          <textarea aria-label="Decision comment" placeholder="comment (required to ask for changes)" value={comment} onChange={(e) => setComment(e.target.value)} />
          <div className="row">
            <button onClick={() => onDecide("approve", comment)}>Approve plan v{pending.version}</button>
            <button className="small" disabled={!comment.trim()} onClick={() => onDecide("revise", comment)}>
              Ask for changes
            </button>
          </div>
        </div>
      )}
      {[...plans].reverse().map((p) => {
        const prev = plans.filter((x) => x.version < p.version && x.decision === "approved").at(-1) ?? plans.filter((x) => x.version < p.version).at(-1);
        const d = planDiff(prev, p);
        return (
          <div key={p.version} className="card plan">
            <h4>
              Plan v{p.version} <span className={`decision dec-${p.decision}`}>{p.decision}</span>
              <span className="muted small-text">
                {" "}
                · by @{p.proposedBy} {ago(now, p.proposedAt)} ago{p.decidedBy ? ` · ${p.decision} by @${p.decidedBy}` : ""}
                {p.comment ? ` · “${p.comment}”` : ""}
              </span>
            </h4>
            {p.designRef && (
              <p className="muted small-text">
                Design: <code>{p.designRef}</code>
              </p>
            )}
            {prev && (
              <p className="small-text">
                vs v{prev.version}: {d.added.map((x) => <span key={`a${x}`} className="add">+{x} </span>)}
                {d.removed.map((x) => <span key={`r${x}`} className="del">−{x} </span>)}
                {d.changed.map((x) => <span key={`c${x}`} className="chg">~{x} </span>)}
                {d.added.length + d.removed.length + d.changed.length === 0 && <span className="muted">no step changes</span>}
              </p>
            )}
            <table className="plansteps">
              <tbody>
                {p.steps.map((s) => (
                  <tr key={s.id}>
                    <td className="id">{s.id}</td>
                    <td className="muted">{s.kind}</td>
                    <td className="muted">{s.repo}</td>
                    <td className="muted">{s.deps.length ? `after ${s.deps.join(", ")}` : ""}</td>
                    <td>{s.title}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

export function GoalPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<GoalDetail>();
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [tab, setTab] = useState<"steps" | "design" | "timeline">("steps");
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    api.goal(id).then((d) => {
      setDetail(d);
      setError(undefined);
      if (d.goal.state === "awaiting_approval" && !d.steps.some((s) => s.kind !== "design")) setTab("design");
    }, (e: Error) => setError(e.message));
    api.timeline(id).then(setTimeline, () => undefined);
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    const es = new EventSource("/v1/stream");
    let t: number | undefined;
    es.addEventListener("changed", () => {
      window.clearTimeout(t);
      t = window.setTimeout(load, 300);
    });
    return () => es.close();
  }, [load]);
  if (error && !detail) return <p className="error">{error}</p>;
  if (!detail) return <p className="muted">Loading…</p>;
  const g = detail.goal;
  const now = Date.now();
  const visible = detail.steps.filter((s) => s.state !== "dropped");
  const decide = (kind: "approve" | "revise", comment: string) => {
    const p = kind === "approve" ? api.approve(g.id, comment.trim() || undefined) : api.revise(g.id, comment.trim());
    p.then(
      () => {
        if (kind === "approve") setTab("steps");
        load();
      },
      (e: Error) => setError(e.message),
    );
  };
  return (
    <section>
      <p>
        <a href="#/goals">← Goals</a>
      </p>
      <h2 className="goaltitle">
        {g.id} · {g.title}
      </h2>
      <p className="muted">
        {g.state.replace(/_/g, " ")} · owner @{g.ownerId} · {visible.filter((s: Step) => s.state === "done").length}/{visible.length} steps done
        {g.primaryRepo ? ` · ${g.primaryRepo}` : ""}
        {g.state === "in_progress" && (
          <button className="small" style={{ marginLeft: 12 }} onClick={() => api.replan(g.id).then(load, (e: Error) => setError(e.message))}>
            Replan
          </button>
        )}
      </p>
      {error && <p className="error">{error}</p>}
      <nav className="tabs">
        {(["steps", "design", "timeline"] as const).map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "steps" ? "Steps" : t === "design" ? `Design${detail.plans.some((p) => p.decision === "pending") ? " •" : ""}` : "Timeline"}
          </button>
        ))}
      </nav>
      {tab === "steps" && (
        <div className="stepsview">
          <div className="dagwrap">
            <Dag detail={detail} selected={selected} onSelect={setSelected} />
          </div>
          {selected ? <StepPanel id={selected} now={now} /> : <p className="muted">Click a step for its brief, holder, notes and facts.</p>}
        </div>
      )}
      {tab === "design" && <DesignTab detail={detail} onDecide={decide} />}
      {tab === "timeline" && (
        <ul className="activity" aria-label="timeline">
          {[...timeline].reverse().map((t) => (
            <li key={t.seq}>
              <span className="age">{ago(now, t.at)}</span> {t.user && <strong>{t.user}</strong>} {t.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
