// Goals board and Goal page (plan §9, journeys doc §2.2–2.3).

import { useCallback, useEffect, useState } from "react";
import { levels } from "../../src/core/dag.ts";
import { partition, STEP_STAGES, stepStage } from "../../src/core/stages.ts";
import type { Goal, Plan, Step } from "../../src/protocol/goal.ts";
import type { DebriefView, GoalDetail, OfferLine, StepView, SuggestView, TimelineEntry, TopicView } from "../../src/protocol/hub.ts";
import { assignText, offerText } from "../../src/core/offers.ts";
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

/** The topic filter, kept per viewer (a convenience only: the board works without it). */
const TOPIC_KEY = "mesh.goals.topics";
function savedTopics(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(TOPIC_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Topic chips: `all` clears the filter; other chips toggle, and goals must carry every chip on. */
function TopicBar({ topics, selected, onChange, onDefine }: { topics: TopicView[]; selected: string[]; onChange: (t: string[]) => void; onDefine: (name: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  return (
    <div className="topics" role="group" aria-label="Filter goals by topic">
      {topics.map((t) => {
        const on = t.name === "all" ? selected.length === 0 : selected.includes(t.name);
        return (
          <button
            key={t.name}
            type="button"
            className={`chip${on ? " on" : ""}`}
            aria-pressed={on}
            title={t.description ?? ""}
            onClick={() => onChange(t.name === "all" ? [] : on ? selected.filter((x) => x !== t.name) : [...selected, t.name])}
          >
            {t.name} <span className="count">{t.goals}</span>
          </button>
        );
      })}
      {adding ? (
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            onDefine(name.trim());
            setName("");
            setAdding(false);
          }}
        >
          <input aria-label="New topic name" placeholder="topic name" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </form>
      ) : (
        <button type="button" className="chip add" onClick={() => setAdding(true)}>
          + topic
        </button>
      )}
      {selected.length > 1 && <span className="muted small-text">goals with all of: {selected.join(" + ")}</span>}
    </div>
  );
}

export function TopicChips({ topics }: { topics?: readonly string[] | undefined }) {
  if (!topics?.length) return null;
  return (
    <span className="chips">
      {topics.map((t) => (
        <span key={t} className="chip static">
          {t}
        </span>
      ))}
    </span>
  );
}

export function GoalsBoard({ progress, onRefresh }: { progress: Record<string, { done: number; total: number; holders: string[] }>; onRefresh: () => void }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [topics, setTopics] = useState<TopicView[]>([]);
  const [selected, setSelected] = useState<string[]>(savedTopics);
  const [title, setTitle] = useState("");
  const [repo, setRepo] = useState("");
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    api.topics().then(
      (ts) => {
        setTopics(ts);
        // A topic someone deleted drops out of the filter.
        setSelected((sel) => sel.filter((s) => ts.some((t) => t.name === s)));
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(load, [load, progress]);
  useEffect(() => {
    try {
      localStorage.setItem(TOPIC_KEY, JSON.stringify(selected));
    } catch {
      /* storage blocked: the filter just isn't remembered */
    }
    api.goals(selected).then(setGoals, (e: Error) => setError(e.message));
  }, [selected, progress]);
  const now = Date.now();
  const recent = (g: Goal) => g.state !== "done" || now - g.updatedAt < 14 * 86_400_000;
  return (
    <section>
      <form
        className="newgoal"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          api.newGoal(title.trim(), repo.trim() || undefined, selected).then(
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
        <button type="submit">Create{selected.length ? ` in ${selected.join(" + ")}` : ""}</button>
      </form>
      <TopicBar
        topics={topics}
        selected={selected}
        onChange={setSelected}
        onDefine={(name) =>
          api.newTopic(name).then(
            () => {
              setError(undefined);
              load();
            },
            (err: Error) => setError(err.message),
          )
        }
      />
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
                    <TopicChips topics={g.topics} />
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
        const who = s.state === "claimed" || s.state === "paused" ? `@${s.holderUser ?? "?"}${h?.agent === "opencode" ? " (opencode)" : ""}${h ? ` · ${h.state === "needs_you" ? `needs ${h.needs ?? "you"}` : h.state}` : ""}` : s.repo;
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

/** MM-4: ranked machines for a step or a goal; one click offers it. */
function AssignPicker({ kind, target, onAssigned, onCancel }: { kind: "step" | "goal"; target: string; onAssigned: (text: string) => void; onCancel: () => void }) {
  const [team, setTeam] = useState(false);
  const [any, setAny] = useState(false);
  const [view, setView] = useState<SuggestView>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    const o = { team, any };
    (kind === "step" ? api.suggestStep(target, o) : api.suggestGoal(target, o)).then(
      (v) => {
        if (!live) return;
        setView(v);
        setError(undefined);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [kind, target, team, any]);
  const assign = (to: string) => {
    const p = kind === "step" ? api.assignStep(target, to) : api.assignGoal(target, to);
    p.then(
      (r) => onAssigned(assignText(kind, target, to, r, false).join(" ")),
      (e: Error) => setError(e.message),
    );
  };
  return (
    <div className="card picker" aria-label="assign picker">
      <p className="picker-flags">
        <label>
          <input type="checkbox" checked={team} onChange={(e) => setTeam(e.target.checked)} /> Team machines
        </label>
        <label>
          <input type="checkbox" checked={any} onChange={(e) => setAny(e.target.checked)} /> Without the repo
        </label>
      </p>
      {view && view.suggestions.length === 0 && <p className="empty">No machine to suggest.</p>}
      {view && view.suggestions.length > 0 && (
        <ul>
          {view.suggestions.map((s) => (
            <li key={s.machine} className="suggestion" data-machine={s.machine}>
              <strong className="to">{s.to}</strong> <span className="reason">{s.reason}</span>{" "}
              <button className="small" aria-label={`Assign to ${s.to}`} onClick={() => assign(s.to)}>
                Assign
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
      <button className="small" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** RL-4: a debrief step's pre-read (report, items), the read button and the decisions made (Revert). */
function DebriefSection({ step, onChange }: { step: Step; onChange: () => void }) {
  const [view, setView] = useState<DebriefView>();
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    api.debrief(step.id).then(
      (v) => {
        setView(v);
        setError(undefined);
      },
      (e: Error) => setError(e.message),
    );
  }, [step.id]);
  useEffect(() => {
    setView(undefined);
    reload();
  }, [reload, step.state, step.updatedAt]);
  const act = (p: Promise<unknown>) =>
    p.then(
      () => {
        reload();
        onChange();
      },
      (e: Error) => setError(e.message),
    );
  const open = step.state === "ready" || step.state === "claimed" || step.state === "paused";
  const current = (step.rounds?.length ?? 0) + 1;
  return (
    <section className="debrief" aria-label="debrief">
      {error && <p className="error">{error}</p>}
      {view && (
        <>
          <p>Assignee: @{view.assignee}</p>
          {view.report?.content ? <pre className="report">{view.report.content}</pre> : <p className="muted">No report.</p>}
          <ul className="items">
            {view.items.map((i) => (
              <li key={i.fp} data-fp={i.fp}>
                {`${i.severity} ${i.title} · ${i.state}`}
                {i.nearMatches.map((m) => ` · possible repeat of ${m.fp}`).join("")}
              </li>
            ))}
          </ul>
          {open &&
            (view.read && view.read.round === current ? (
              <p>Read by @{view.read.user}</p>
            ) : (
              <p>
                <button className="small" aria-label="Mark pre-read as read" onClick={() => void act(api.read(step.id))}>
                  Mark as read
                </button>
              </p>
            ))}
          {view.decided.length > 0 && (
            <>
              <h4>Decided in debrief</h4>
              <ul>
                {view.decided.map((d) => (
                  <li className="decided" data-fp={d.fp} key={`${d.fp}:${d.at}`}>
                    {`${d.fp} ${d.disposition} (was ${d.from}) · @${d.decider.kind === "person" ? d.decider.user : d.decider.key}`}
                    {d.revertable && (
                      <>
                        {" "}
                        <button className="small" aria-label={`Revert ${d.fp}`} onClick={() => void act(api.revert(step.id, d.fp))}>
                          Revert
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

function StepPanel({ id, now, offer, onChange }: { id: string; now: number; offer?: OfferLine | undefined; onChange: () => void }) {
  const [view, setView] = useState<StepView>();
  const [error, setError] = useState<string>();
  const [comment, setComment] = useState("");
  const [reopenIds, setReopenIds] = useState("");
  const [picking, setPicking] = useState(false);
  const [assigned, setAssigned] = useState<string>();
  const reload = useCallback(() => {
    api.step(id).then(setView, (e: Error) => setError(e.message));
  }, [id]);
  useEffect(() => {
    setView(undefined);
    setPicking(false);
    setAssigned(undefined);
    reload();
  }, [reload]);
  const act = (p: Promise<unknown>) =>
    p.then(
      () => {
        setComment("");
        reload();
        onChange();
      },
      (e: Error) => setError(e.message),
    );
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
      {offer && <p className="offer">{offerText(offer)}</p>}
      {assigned && <p className="assigned">{assigned}</p>}
      {step.policy?.mode === "debrief" && <DebriefSection step={step} onChange={onChange} />}
      {step.state === "ready" && step.kind !== "gate" && step.policy?.mode !== "debrief" && offer?.state !== "offered" && !picking && (
        <p>
          <button className="small" aria-label="Assign step" onClick={() => setPicking(true)}>
            Assign
          </button>
        </p>
      )}
      {picking && (
        <AssignPicker
          kind="step"
          target={step.id}
          onAssigned={(text) => {
            setPicking(false);
            setAssigned(text);
            reload();
            onChange();
          }}
          onCancel={() => setPicking(false)}
        />
      )}
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
      {step.policy && (
        <p className="muted small-text" aria-label="step rules">
          {[
            step.policy.role && `role ${step.policy.role}`,
            step.policy.acs?.length && `covers ${step.policy.acs.join(", ")}`,
            step.policy.blind?.length && `blind to ${step.policy.blind.join(", ")}`,
            step.policy.reads && `reads ${step.policy.reads.join(", ") || "nothing"}`,
            step.policy.max_rounds && `max ${step.policy.max_rounds} rounds`,
            step.policy.park_on?.length && `parks on ${step.policy.park_on.join(", ")}`,
            step.policy.route && `routes ${Object.entries(step.policy.route).map(([b, t]) => `${b}→${t}`).join(", ")}`,
            step.policy.target && `reviews ${step.policy.target}`,
            step.policy.must_cover && `must cover ${step.policy.must_cover === "all" ? "all criteria" : step.policy.must_cover.join(", ")}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {(step.rounds?.length ?? 0) > 0 && (
        <>
          <h4>Rounds</h4>
          <table className="facts" aria-label="rounds">
            <tbody>
              {step.rounds?.map((r) => (
                <tr key={r.n}>
                  <td>#{r.n}</td>
                  <td>@{r.user}</td>
                  <td>{r.verdict ?? r.outcome}</td>
                  <td>
                    {r.acs ? Object.entries(r.acs).map(([a, v]) => `${a}:${v === "met" ? "✓" : v === "not_met" ? "✗" : "–"}`).join(" ") : ""}
                    {r.failures?.length ? ` ${r.failures.map((f) => f.bucket).join(", ")}` : ""}
                    {r.reconcile ? ` missing ${r.reconcile.missing.join(", ")}` : ""}
                    {r.parked ? ` parked: ${r.parked}` : ""}
                    {r.gate ? ` gate by @${r.gate.by}${r.gate.rule ? ` (${r.gate.rule})` : ""}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {step.kind === "gate" && step.state === "ready" && (
        <div className="decide" aria-label="gate decision">
          <p>
            <strong>{step.policy?.gate ?? "Gate"}</strong> waits for your decision.
          </p>
          <textarea aria-label="Gate comment" placeholder="comment" value={comment} onChange={(e) => setComment(e.target.value)} />
          <input aria-label="Steps to reopen" placeholder="steps to reopen when rejecting, e.g. spec,develop" value={reopenIds} onChange={(e) => setReopenIds(e.target.value)} />
          <div className="row">
            <button onClick={() => act(api.approveStep(step.id, comment.trim() || undefined))}>Approve</button>
            <button className="small" disabled={!reopenIds.trim()} onClick={() => act(api.rejectStep(step.id, reopenIds.split(",").map((x) => x.trim()).filter(Boolean), comment.trim() || undefined))}>
              Reject and reopen
            </button>
          </div>
        </div>
      )}
      {(step.state === "parked" || step.state === "failed") && (
        <div className="decide" aria-label="parked">
          <p>
            <strong>{step.state === "parked" ? "Parked" : "Failed"}:</strong> {step.parkedReason ?? step.summary ?? ""}
          </p>
          <textarea aria-label="Resume comment" placeholder="what to do differently (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
          <button onClick={() => act(api.resumeStep(step.id, comment.trim() || undefined))}>Resume</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {step.state === "ready" && step.kind !== "gate" && <code className="hint">mesh run {step.repo || "<repo>"} --step {step.id}</code>}
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

/** A goal's topics with × to untag, and a picker of the defined topics to tag. */
function GoalTopics({ goal, onChange, onError }: { goal: Goal; onChange: () => void; onError: (m: string) => void }) {
  const [all, setAll] = useState<TopicView[]>([]);
  useEffect(() => {
    api.topics().then(setAll, (e: Error) => onError(e.message));
  }, [goal.id, onError]);
  const have = goal.topics ?? [];
  const change = (c: { add?: string[]; remove?: string[] }) => api.goalTopics(goal.id, c).then(onChange, (e: Error) => onError(e.message));
  const free = all.filter((t) => t.name !== "all" && !have.includes(t.name));
  return (
    <p className="topics" aria-label="topics">
      <span className="muted small-text">topics</span>
      {have.map((t) => (
        <span key={t} className="chip static">
          {t}
          <button type="button" className="x" aria-label={`Remove topic ${t}`} onClick={() => void change({ remove: [t] })}>
            ×
          </button>
        </span>
      ))}
      {free.length > 0 && (
        <select aria-label="Add a topic" value="" onChange={(e) => e.target.value && void change({ add: [e.target.value] })}>
          <option value="">+ add</option>
          {free.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      {have.length === 0 && free.length === 0 && <span className="muted small-text">none yet; define topics on the Goals page</span>}
    </p>
  );
}

export function GoalPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<GoalDetail>();
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [tab, setTab] = useState<"steps" | "design" | "timeline">("steps");
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const [picking, setPicking] = useState(false);
  const [assigned, setAssigned] = useState<string>();
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
  const offerable = detail.steps.filter((s) => s.state === "ready" && s.kind !== "gate" && s.policy?.mode !== "debrief" && detail.offers?.[s.id]?.state !== "offered");
  const canAssign = g.state !== "done" && g.state !== "dropped" && offerable.length > 0;
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
        {canAssign && !picking && (
          <button className="small" style={{ marginLeft: 12 }} aria-label="Assign goal" onClick={() => setPicking(true)}>
            Assign
          </button>
        )}
      </p>
      {picking && (
        <AssignPicker
          kind="goal"
          target={g.id}
          onAssigned={(text) => {
            setPicking(false);
            setAssigned(text);
            load();
          }}
          onCancel={() => setPicking(false)}
        />
      )}
      {assigned && <p className="assigned">{assigned}</p>}
      <GoalTopics goal={g} onChange={load} onError={setError} />
      {error && <p className="error">{error}</p>}
      <p className="stages" aria-label="step stages">
        {partition(detail.steps, stepStage, STEP_STAGES)
          .filter((p) => p.items.length)
          .map((p) => (
            <span key={p.stage} className={`stage st-${p.stage.replace(/ /g, "-")}`}>
              {p.stage} <strong>{p.items.length}</strong>
            </span>
          ))}
      </p>
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
          {selected ? <StepPanel id={selected} now={now} offer={detail.offers?.[selected]} onChange={load} /> : <p className="muted">Click a step for its brief, holder, notes and facts.</p>}
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
