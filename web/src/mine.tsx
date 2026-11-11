// "Mine" (MM-1): every machine logged in as the signed-in user and what each session on it does.
// Read-only. Refetches after an SSE `changed` hint (`hint` changes) and every 15 s, because a
// metadata-only sync sends no hint.

import { useCallback, useEffect, useState } from "react";
import type { FleetMachine, FleetView } from "../../src/protocol/hub.ts";
import { api } from "./api.ts";
import { ago } from "./goals.tsx";

function Machine({ m, now }: { m: FleetMachine; now: number }) {
  const n = m.repos.length;
  return (
    <section className="machine card">
      <h3>
        <span className={`dot ${m.online ? "on" : "off"}`} /> {m.nickname ? `${m.nickname} (${m.hostname})` : m.hostname}
        {m.labels?.length ? (
          <>
            {" "}
            <span className="labels">{m.labels.join(", ")}</span>
          </>
        ) : null}
        {m.current && <span className="muted"> · this machine</span>}
      </h3>
      <p className="muted">
        {m.online ? "online" : `last seen ${ago(now, m.lastSeen)} ago`} · share {m.share ?? "?"} · {n} {n === 1 ? "repo" : "repos"}
      </p>
      {m.sessions.length === 0 ? (
        <p className="muted">no sessions</p>
      ) : (
        <table className="sessions">
          <thead>
            <tr>
              <th>repo</th>
              <th>name</th>
              <th>state</th>
              <th>step</th>
              <th>labels</th>
              <th>age</th>
            </tr>
          </thead>
          <tbody>
            {m.sessions.map((s) => (
              <tr key={s.sid} className={`st-${s.state}`}>
                <td>{s.repo || "-"}</td>
                <td>{s.name || s.sid.slice(0, 8)}</td>
                <td>
                  {s.state}
                  {s.needs ? ` (${s.needs})` : ""}
                </td>
                <td>{s.step ?? "no step"}</td>
                <td>{s.labels?.join(", ") ?? ""}</td>
                <td className="age">{ago(now, s.lastEventAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function MinePage({ hint }: { hint: number }) {
  const [view, setView] = useState<FleetView>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setView(await api.fleet());
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const poll = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(poll);
  }, [load]);

  useEffect(() => {
    void load();
  }, [hint, load]);

  return (
    <div className="mine">
      <h2>My machines</h2>
      {error && <p className="error">{error}</p>}
      {!view ? (
        !error && <p className="muted">Loading…</p>
      ) : view.machines.length === 0 ? (
        <p className="muted">No machines logged in as you yet. Run mesh login on each machine.</p>
      ) : (
        view.machines.map((m) => <Machine key={m.id} m={m} now={view.now} />)
      )}
    </div>
  );
}
