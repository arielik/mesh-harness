// "Roster" (RL-5): the agents of the repos the user sees and of catalog sources, grouped by name,
// with the flags diverged / pinned / behind / modified. Read-only. Refetches after an SSE `changed`
// hint (`hint` changes).

import { useCallback, useEffect, useState } from "react";
import type { AgentCopy, AgentGroup, AgentsView, AgentVersion } from "../../src/protocol/roster.ts";
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

function Group({ g }: { g: AgentGroup }) {
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
