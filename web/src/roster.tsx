// "Roster" (RL-5): the agents of the repos the user sees and of catalog sources, grouped by name,
// with the flags diverged / pinned / behind / modified. Read-only. Refetches after an SSE `changed`
// hint (`hint` changes).

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AgentCopy, AgentGroup, AgentHashStats, AgentStats, AgentsView, AgentVersion } from "../../src/protocol/roster.ts";
import { api } from "./api.ts";

const FLAGS = ["diverged", "pinned", "behind", "modified"] as const;
const c7 = (s: string | undefined) => (s ?? "").slice(0, 7);

function Copy({ c }: { c: AgentCopy }) {
  const origin = c.origin === "repo" ? "repo" : `catalog ${c7(c.commit)}`;
  return (
    <li className="roster-copy" data-key={c.key}>
      <code>{c.key}</code> <span className="muted">{origin}</span>
      {c.origin === "repo" && <span className="muted"> · {c.repo.id}</span>}
      {c.machines !== undefined && c.machines > 1 && <span className="muted"> · {c.machines} machines</span>}
      {c.pin && <span className="roster-pin"> · pin {c7(c.pin.commit)}</span>}
      {c.behind && <span className="roster-mark"> · behind</span>}
      {c.modified && <span className="roster-mark"> · modified</span>}
    </li>
  );
}

function Version({ v }: { v: AgentVersion }) {
  return (
    <div className="roster-version" data-hash={v.hash}>
      <p>
        <code>{v.hash.slice(0, 12)}</code> {v.description ?? <span className="muted">no description</span>}
      </p>
      {(!!v.model || (v.tools?.length ?? 0) > 0 || (v.rules?.length ?? 0) > 0) && (
        <p className="muted">
          {[v.model ? `model: ${v.model}` : "", v.tools?.length ? `tools: ${v.tools.join(", ")}` : "", v.rules?.length ? `rules: ${v.rules.join(", ")}` : ""].filter(Boolean).join(" · ")}
        </p>
      )}
      <ul>
        {v.copies.map((c) => (
          <Copy key={`${c.key}\n${c.origin}\n${c.kind}\n${c.repo.id}\n${c.path}\n${c.pin?.hash ?? ""}`} c={c} />
        ))}
      </ul>
    </div>
  );
}

const STATS_DAYS = 30;

/** RL-6: the distinct copy keys of a group: versions in reply order, then copies in order. */
function groupKeys(g: AgentGroup): string[] {
  const keys: string[] = [];
  for (const v of g.versions) for (const c of v.copies) if (!keys.includes(c.key)) keys.push(c.key);
  return keys;
}

const num = (n: number) => String(n);

function StatsRow({ k, h }: { k: string; h: AgentHashStats }) {
  const cells: [string, ReactNode][] = [
    ["hash", h.hash ? h.hash.slice(0, 12) : "-"],
    ["runs", num(h.runs)],
    ["failures", num(h.failures)],
    ["cost", h.meanCostUsd === null ? "-" : `$${h.meanCostUsd.toFixed(2)}`],
    ["duration", h.meanDurationMs === null ? "-" : `${(h.meanDurationMs / 1000).toFixed(1)}s`],
    ["raised", num(h.raised)],
    ["accepted", num(h.accepted)],
    ["dismissed-agents", num(h.dismissedByAgents)],
    ["dismissed-people", num(h.dismissedByPeople)],
    ["reinstated", num(h.reinstated)],
    ["carried", num(h.carried)],
    ["regressions", num(h.regressions)],
    ["undeclared", num(h.undeclaredRules)],
    ["uncalibrated", num(h.uncalibrated)],
    ["calibration", h.calibration ? <a href={`#/goal/${h.calibration}`}>{h.calibration}</a> : "-"],
  ];
  return (
    <tr data-key={k} data-hash={h.hash}>
      {cells.map(([col, v]) => (
        <td key={col} data-col={col}>
          {v}
        </td>
      ))}
    </tr>
  );
}

const HEADS = ["hash", "runs", "fail", "cost", "time", "raised", "accepted", "dism. agents", "dism. people", "reinstated", "carried", "regr.", "undeclared", "uncalibrated", "calibration"];

/** RL-6: the statistics table of a group (one row per key and hash). */
function Stats({ stats }: { stats: { key: string; s: AgentStats }[] }) {
  const rows = stats.flatMap(({ key, s }) => s.hashes.map((h) => ({ key, h })));
  if (rows.length === 0) return <p className="empty">No runs or findings in the last {STATS_DAYS} days.</p>;
  return (
    <div className="roster-stats-wrap">
      <table className="roster-stats">
        <thead>
          <tr>
            {HEADS.map((x) => (
              <th key={x}>{x}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, h }) => (
            <StatsRow key={`${key}\n${h.hash}`} k={key} h={h} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Group({ g }: { g: AgentGroup }) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<{ key: string; s: AgentStats }[]>();
  const [error, setError] = useState<string>();

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setStats(undefined);
    setError(undefined);
    try {
      const keys = groupKeys(g);
      const got = await Promise.all(keys.map(async (key) => ({ key, s: await api.agentStats(key, STATS_DAYS) })));
      setStats(got);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="roster-group card" data-name={g.name}>
      <h3>
        {g.name}
        {FLAGS.filter((f) => g[f]).map((f) => (
          <span key={f} className="roster-flag">
            {f}
          </span>
        ))}
      </h3>
      <button type="button" className="roster-stats-toggle" aria-expanded={open} onClick={() => void toggle()}>
        Stats
      </button>
      {open && error && <p className="error">{error}</p>}
      {open && stats && <Stats stats={stats} />}
      {g.versions.map((v) => (
        <Version key={v.hash} v={v} />
      ))}
    </section>
  );
}

export function RosterPage({ hint }: { hint: number }) {
  const [view, setView] = useState<AgentsView>();
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setView(await api.agents());
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, hint]);

  const groups = view?.agents ?? [];
  const text = filter;
  const shown = text ? groups.filter((g) => g.name.toLowerCase().includes(text.toLowerCase())) : groups;
  return (
    <div className="roster">
      <h2>Roster</h2>
      {error && <p className="error">{error}</p>}
      <input name="roster-filter" type="search" placeholder="filter by name" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {view && groups.length === 0 ? (
        <p className="empty">No agents on the roster yet.</p>
      ) : view && shown.length === 0 ? (
        <p className="empty">No agent matches "{text}".</p>
      ) : (
        shown.map((g) => <Group key={g.name} g={g} />)
      )}
      {view && (
        <section className="roster-sources">
          <h3>Catalog sources</h3>
          {view.sources.length === 0 ? (
            <p className="muted">none registered</p>
          ) : (
            <ul>
              {view.sources.map((s) => (
                <li key={s.repo} data-repo={s.repo}>
                  <code>{s.repo}</code> · {s.folder} · {s.count} agent(s){s.commit ? ` · ${c7(s.commit)}` : ""}
                  {s.calibrator ? ` · calibrator ${s.calibrator}` : ""}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
