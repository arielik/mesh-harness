import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Attention, LiveView, ProviderInfo } from "../../src/protocol/hub.ts";
import { api, ApiError } from "./api.ts";
import { GoalPage, GoalsBoard } from "./goals.tsx";
import "./styles.css";

function ago(now: number, at: number | undefined): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const STATE_LABEL: Record<string, string> = { needs_you: "needs you", working: "working", idle: "idle", stalled: "stalled", ended: "ended" };

function Login({ onDone }: { onDone: () => void }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  useEffect(() => {
    api.providers().then(setProviders, (e: Error) => setError(e.message));
  }, []);
  const submit = async (p: ProviderInfo) => {
    setError(undefined);
    try {
      if (p.flows.includes("none")) await api.loginNone(p.id);
      else await api.loginToken(p.id, token);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <main className="login">
      <h1>mesh</h1>
      <p className="muted">Sign in to see your team's Claude sessions and goals.</p>
      {providers.map((p) => (
        <section key={p.id} className="card">
          <h2>{p.label}</h2>
          {p.flows.includes("redirect") && (
            <a className="button" href={`/auth/${encodeURIComponent(p.id)}/start?client=web`}>
              Continue with {p.label}
            </a>
          )}
          {p.flows.includes("token") && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit(p);
              }}
            >
              <input aria-label={`${p.label} token`} type="password" placeholder="token" value={token} onChange={(e) => setToken(e.target.value)} />
              <button type="submit">Sign in</button>
            </form>
          )}
          {p.flows.includes("none") && <button onClick={() => void submit(p)}>Continue (local)</button>}
        </section>
      ))}
      {error && <p className="error">{error}</p>}
    </main>
  );
}

function AttentionList({ items, now, onApprove }: { items: Attention[]; now: number; onApprove: (goal: string) => void }) {
  if (items.length === 0) return <p className="muted calm">Nothing needs you.</p>;
  return (
    <ul className="attention">
      {items.map((a, i) => (
        <li key={i} className={`att att-${a.kind}`}>
          <span className="kind">{a.kind.replace("_", " ")}</span>
          <span className="text">{a.text}</span>
          <span className="age">{ago(now, a.at)}</span>
          {a.kind === "approval" && a.goal && !a.step && (
            <button className="small" onClick={() => onApprove(a.goal as string)}>
              Approve
            </button>
          )}
          {(a.kind === "approval" || a.kind === "parked") && a.goal && a.step && <a href={`#/goal/${a.goal}`}>open {a.step}</a>}
          {a.kind === "question" && a.question !== undefined && <code className="hint">mesh answer {a.question} …</code>}
        </li>
      ))}
    </ul>
  );
}

function useRoute(): string {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function Header({ data, route, onLogout }: { data: LiveView; route: string; onLogout: () => void }) {
  const online = data.people.filter((p) => p.online);
  const machinesOnline = data.people.flatMap((p) => p.machines.filter((m) => m.online));
  const counts = machinesOnline.reduce<Record<string, number>>((acc, m) => {
    for (const [k, v] of Object.entries(m.counts)) acc[k] = (acc[k] ?? 0) + v;
    return acc;
  }, {});
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <header className="top">
      <strong>mesh</strong>
      <nav className="nav">
        <a href="#/" className={route === "#/" ? "active" : ""}>
          Live{data.attention.length ? ` (${data.attention.length})` : ""}
        </a>
        <a href="#/goals" className={route.startsWith("#/goal") ? "active" : ""}>
          Goals
        </a>
      </nav>
      <span className="muted">
        {online.length} {online.length === 1 ? "person" : "people"} · {machinesOnline.length} machines · {total} sessions
        {counts.working ? ` · working ${counts.working}` : ""}
        {counts.needs_you ? ` · needs someone ${counts.needs_you}` : ""}
        {counts.stalled ? ` · stalled ${counts.stalled}` : ""}
      </span>
      <span className="spacer" />
      <span>{data.me.name}</span>
      <button className="small" onClick={onLogout}>
        Sign out
      </button>
    </header>
  );
}

function Live({ data, onApprove }: { data: LiveView; onApprove: (goal: string) => void }) {
  const sessions = data.people.flatMap((p) => p.sessions.filter((s) => s.state !== "ended"));
  return (
    <>
      <section>
        <h2>Needs attention ({data.attention.length})</h2>
        <AttentionList items={data.attention} now={data.now} onApprove={onApprove} />
      </section>

      <section>
        <h2>Active goals</h2>
        {data.goals.filter((g) => g.state !== "done" && g.state !== "dropped").length === 0 && <p className="muted">No active goals. Create one with <code>mesh goal new</code>.</p>}
        <table className="goals">
          <tbody>
            {data.goals
              .filter((g) => g.state !== "done" && g.state !== "dropped")
              .map((g) => (
                <tr key={g.id}>
                  <td className="id">
                    <a href={`#/goal/${g.id}`}>{g.id}</a>
                  </td>
                  <td>
                    <a href={`#/goal/${g.id}`}>{g.title}</a>
                  </td>
                  <td className="muted">{g.state.replace("_", " ")}</td>
                  <td>
                    <div className="bar" title={`${g.done}/${g.total}`}>
                      <div style={{ width: `${g.total ? (100 * g.done) / g.total : 0}%` }} />
                    </div>
                  </td>
                  <td className="muted">
                    {g.done}/{g.total}
                  </td>
                  <td className="muted">{g.holders.join(", ")}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>People</h2>
        <div className="people">
          {data.people.map((p) => (
            <div key={p.user.id} className="card person">
              <div className="row">
                <span className={`dot ${p.online ? "on" : "off"}`} />
                <strong>{p.user.name}</strong>
                <span className="muted">{p.machines.map((m) => m.hostname).join(", ")}</span>
              </div>
              {p.sessions.filter((s) => s.state !== "ended").map((s) => (
                <div key={s.sid} className={`session st-${s.state}`}>
                  <span className="repo">{s.repo ?? s.name ?? s.sid.slice(0, 8)}</span>
                  <span className="step">{s.step ?? "—"}</span>
                  <span className="state">{STATE_LABEL[s.state] ?? s.state}{s.needs ? ` (${s.needs})` : ""}</span>
                  <span className="age">{ago(data.now, s.lastTurnAt)}</span>
                </div>
              ))}
              {p.machines.some((m) => m.online) && p.sessions.filter((s) => s.state !== "ended").length === 0 && (
                <p className="muted small-text">{Object.values(p.machines.reduce<Record<string, number>>((a, m) => ({ ...a, ...m.counts }), {})).reduce((a, b) => a + b, 0)} private sessions</p>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Activity</h2>
        <ul className="activity">
          {data.activity.slice(0, 15).map((a) => (
            <li key={a.seq}>
              <span className="age">{ago(data.now, a.at)}</span> {a.user && <strong>{a.user}</strong>} {a.text}
            </li>
          ))}
        </ul>
      </section>
      {sessions.length === 0 && data.goals.length === 0 && <p className="muted">Tip: run <code>mesh login --hub {location.origin}</code> on your machine.</p>}
    </>
  );
}

function App() {
  const [data, setData] = useState<LiveView>();
  const [needLogin, setNeedLogin] = useState(false);
  const [error, setError] = useState<string>();
  const timer = useRef<number | undefined>(undefined);
  const route = useRoute();

  const load = useCallback(async () => {
    try {
      setData(await api.live());
      setNeedLogin(false);
      setError(undefined);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedLogin(true);
      else setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(poll);
  }, [load]);

  useEffect(() => {
    if (needLogin || !data) return;
    const es = new EventSource("/v1/stream");
    es.addEventListener("changed", () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void load(), 300);
    });
    return () => es.close();
  }, [needLogin, data === undefined, load]);

  if (needLogin) return <Login onDone={() => void load()} />;
  if (!data) return <main className="muted">{error ?? "Loading…"}</main>;
  const goalMatch = /^#\/goal\/([^/]+)$/.exec(route);
  const progress = Object.fromEntries(data.goals.map((g) => [g.id, { done: g.done, total: g.total, holders: g.holders }]));
  return (
    <main>
      <Header data={data} route={route} onLogout={() => void api.logout().finally(() => setNeedLogin(true))} />
      {error && <p className="error">{error}</p>}
      {goalMatch ? (
        <GoalPage key={goalMatch[1]} id={decodeURIComponent(goalMatch[1] as string)} />
      ) : route === "#/goals" ? (
        <GoalsBoard progress={progress} onRefresh={() => void load()} />
      ) : (
        <Live data={data} onApprove={(goal) => void api.approve(goal).then(load, (e: Error) => setError(e.message))} />
      )}
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
