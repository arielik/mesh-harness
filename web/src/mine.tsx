// "Mine" (MM-1): every machine logged in as the signed-in user and what each session on it does.
// Read-only. Refetches after an SSE `changed` hint (`hint` changes) and every 15 s, because a
// metadata-only sync sends no hint.

import { useCallback, useEffect, useState } from "react";
import type { DebriefList, DebriefSummary, DecidedView, FleetMachine, FleetView, OfferView } from "../../src/protocol/hub.ts";
import type { PulseView } from "../../src/protocol/pulse.ts";
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

/**
 * MM-3: steps offered to the user's machines. The web declines; accepting needs a session (`mesh accept`).
 * RL-4: then the user's debriefs (started with `mesh debrief`) and the decisions made in them (Revert).
 */
function Offers({
  offers,
  debriefs,
  decided,
  onDecline,
  onRevert,
}: {
  offers: OfferView[];
  debriefs: DebriefSummary[];
  decided: DecidedView[];
  onDecline: (step: string) => void;
  onRevert: (step: string, fp: string) => void;
}) {
  return (
    <section className="offers">
      <h2>Assigned to you</h2>
      {offers.length === 0 && debriefs.length === 0 && decided.length === 0 ? (
        <p className="muted">Nothing is assigned to you.</p>
      ) : (
        <>
          {offers.length + debriefs.length > 0 && (
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
              {debriefs.map((d) => (
                <li className="debrief" data-step={d.step} key={d.step}>
                  {`${d.step} "${d.title}" · debrief · ${d.items} item(s) to decide`} <a href={`#/goal/${encodeURIComponent(d.goal)}`}>open</a> <code>mesh debrief {d.step}</code>
                </li>
              ))}
            </ul>
          )}
          {decided.length > 0 && (
            <>
              <h3>Decided in debrief</h3>
              <ul>
                {decided.map((e) => (
                  <li className="decided" data-fp={e.fp} key={`${e.step}:${e.fp}:${e.at}`}>
                    {`${e.fp} ${e.disposition} (was ${e.from}) · ${e.step} · "${e.title}"`}{" "}
                    <button type="button" aria-label={`Revert ${e.fp}`} onClick={() => onRevert(e.step, e.fp)}>
                      Revert
                    </button>
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

/** RL-3: the user's pulses and their recent slots. Read-only: `mesh pulse` changes them. */
function Pulses({ pulses }: { pulses: PulseView[] }) {
  return (
    <section className="pulses">
      <h2>Pulses</h2>
      {pulses.length === 0 ? (
        <p className="muted">No pulses. Create one with mesh pulse add.</p>
      ) : (
        pulses.map((p) => (
          <div className="pulse card" data-pulse={p.id} key={p.id}>
            <h3>
              {p.id} "{p.title}"
            </h3>
            <p className="muted">
              {p.schedule} · {p.enabled ? "active" : "paused"}
              {p.nextAt !== undefined ? ` · next ${new Date(p.nextAt).toLocaleString()}` : ""}
            </p>
            {p.recent.length > 0 && (
              <ul className="slots">
                {p.recent.map((s) => (
                  <li key={s.slot} data-slot={s.slot} className={`slot-${s.state}`}>
                    {s.slot} {s.state}
                    {s.reason ? ` (${s.reason})` : ""}
                    {s.goal ? ` ${s.goal}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))
      )}
    </section>
  );
}

export function MinePage({ hint }: { hint: number }) {
  const [view, setView] = useState<FleetView>();
  const [offers, setOffers] = useState<OfferView[]>([]);
  const [pulses, setPulses] = useState<PulseView[]>([]);
  const [debriefs, setDebriefs] = useState<DebriefList>({ debriefs: [], decided: [] });
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [fleet, open, mine, deb] = await Promise.all([
        api.fleet(),
        api.offers().catch(() => [] as OfferView[]),
        api.pulses().catch(() => [] as PulseView[]),
        api.debriefs().catch((): DebriefList => ({ debriefs: [], decided: [] })),
      ]);
      setView(fleet);
      setOffers(open);
      setPulses(mine);
      setDebriefs(deb);
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

  const revert = useCallback(
    (step: string, fp: string) => {
      api.revert(step, fp).then(
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
      <Offers offers={offers} debriefs={debriefs.debriefs} decided={debriefs.decided} onDecline={decline} onRevert={revert} />
      <Pulses pulses={pulses} />
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
