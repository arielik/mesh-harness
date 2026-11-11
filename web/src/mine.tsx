// "Mine" (MM-1): every machine logged in as the signed-in user and what each session on it does.
// Read-only. Refetches after an SSE `changed` hint (`hint` changes) and every 15 s, because a
// metadata-only sync sends no hint.

import { useCallback, useEffect, useState } from "react";
import type { FleetMachine, FleetView, OfferView } from "../../src/protocol/hub.ts";
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

/** MM-3: steps offered to the user's machines. The web declines; accepting needs a session (`mesh accept`). */
function Offers({ offers, onDecline }: { offers: OfferView[]; onDecline: (step: string) => void }) {
  return (
    <section className="offers">
      <h2>Assigned to you</h2>
      {offers.length === 0 ? (
        <p className="muted">Nothing is assigned to you.</p>
      ) : (
        <ul>
          {offers.map((o) => (
            <li className="offer" key={o.step}>
              <strong>{o.step}</strong> "{o.title}" · from @{o.by} · to {o.to}
              {o.note ? <span className="muted"> · {o.note}</span> : null}{" "}
              <button type="button" onClick={() => onDecline(o.step)}>
                Decline
              </button>{" "}
              <code>mesh accept {o.step}</code>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function MinePage({ hint }: { hint: number }) {
  const [view, setView] = useState<FleetView>();
  const [offers, setOffers] = useState<OfferView[]>([]);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [fleet, open] = await Promise.all([api.fleet(), api.offers().catch(() => [] as OfferView[])]);
      setView(fleet);
      setOffers(open);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const decline = useCallback(
    (step: string) => {
      api.decline(step).then(
        () => void load(),
        (e: Error) => setError(e.message),
      );
    },
    [load],
  );

  useEffect(() => {
    const poll = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(poll);
  }, [load]);

  useEffect(() => {
    void load();
  }, [hint, load]);

  return (
    <div className="mine">
      <Offers offers={offers} onDecline={decline} />
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
