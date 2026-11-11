# My mesh, labels and assign (design, 2026-11-11)

One person often runs mesh on several machines (m1 at the desk, m2 a lab box). Today the hub knows
each machine (a mesh installation, v0.1.5) but shows a person's sessions without a step only when the
machine shares them with the whole team (`shareSessions: all`, v0.1.7). Work can be handed to a
session only by its holder claiming a ready step. This design adds:

1. **My mesh**: every machine logged in as me and what each session on it is doing.
2. **Labels**: what a session (or a machine) is for, using the goal topic names.
3. **Assign**: from any session or console, offer a goal or step to another machine or session; the
   receiver accepts it automatically (by policy) or by hand.
4. **Suggest**: rank where to send work, and small tools around it.

It stays generic: nothing here is specific to one team or one identity provider. "User" means the
hub's user id (from any provider: Kanidm, GitLab, a token).

Owner decisions (2026-11-11): the new visibility `me` is the default for new setups; the default
accept policy is `self`; starting a new session on the receiving machine (`launch`) is opt-in per
machine; labels reuse goal topic names, free text allowed with a warning; verbs `assign`, `accept`,
`decline`, `withdraw`.

Delivered as four rows, each a release: MM-1 (v0.1.9), MM-2 (v0.1.10), MM-3 (v0.1.11), MM-4 (v0.1.12).

## Terms

| Term | Meaning |
|---|---|
| **Machine** | A mesh installation logged in to the hub (unchanged). It gets an optional **nickname** (unique per user, `[a-z0-9][a-z0-9-]{0,31}`) used wherever a machine is named (`--to m2`). |
| **My mesh (fleet)** | The calling user's machines with, per machine: online, last seen, counts, nickname, labels, repo inventory, accept policy, and its sessions (metadata). |
| **Visibility** | `shareSessions: steps \| me \| all`. `me` (new, the default for new setups) syncs metadata of every session, and the hub shows sessions without a step only to their owner. `steps` and `all` keep their meaning. |
| **Repo inventory** | Repo ids (normalised remote, `core/repo-id.ts`) the daemon finds under its workspace roots, with the repo name. Answers "can m2 work on this repo". Ids and names only, no paths. |
| **Label** | A short name on a session (`perf`, `dataplane`) saying what it is for. Same syntax as a topic name. Machine labels say what a machine has (`perf-lab`, `gpu`). |
| **Offer (assignment)** | A step offered to a target (a machine, optionally one session on it) by a user from a session or console. States: `offered → accepted \| declined \| expired \| withdrawn`. An accepted offer ends in a claim by a session on the target machine. |
| **Accept policy** | Who may trigger a machine's (or one session's) agents directly: a list of `self`, `user:<id>`, `machine:<nickname or id>`, or `off`. A matching sender's offer is accepted automatically; otherwise it waits in the receiver's **Assigned to you** list. |
| **Coordinator** | Any session that uses `mesh_fleet` / `mesh_assign`. A role, not a kind of session. |

## MM-1: My mesh (read-only)

**Daemon.**
- Config `shareSessions` gains `me`; `mesh setup` writes `me` for new setups (existing configs keep
  their value). `mesh setup --share steps|me|all` changes it.
- Sync carries the visibility (`share`), and, at most every few minutes or when it changes, the repo
  inventory (scan of workspace roots, depth-limited, cached) and the machine nickname.
- With `me` or `all`, sessions without a step are sent as metadata (`sessionMetadata`, unchanged).

**Hub.**
- Stores per machine: `share`, `nickname`, `repos` (id, name), `labels` (MM-2), `accept` (MM-3).
  One migration on SQLite and Postgres.
- Session visibility rule, one function used everywhere sessions are listed (`/v1/live`, fleet):
  a session holding a step is visible to members as today; a session without a step is visible to
  members only when its machine shares `all`, and always to its owner.
- `GET /v1/fleet` (member; `live:read` scope): the caller's machines and sessions (own sessions
  regardless of share level), ordered: online first, then by last seen.
- `POST /v1/machines/:id/name {nickname}` (owner of the machine): set or clear the nickname; unique
  per user (409 on clash). `mesh machine name <nickname>` from that machine; `--machine` to name another of mine.
- `/v1/live` uses the visibility rule (team members don't see my `me` sessions; I do).

**CLI / TUI / web / MCP.**
- `mesh machines` (alias `mesh fleet`): one block per machine: nickname or hostname, online/last seen,
  share level, repos count, then its sessions (repo, name, state/needs, step, labels, age).
  `--json`.
- TUI: a key (`m`) toggles a **My machines** panel listing other machines' sessions read-only.
- Web: a **Mine** tab with the same data, live via the existing SSE hints.
- MCP tool `mesh_fleet` (no args): the same text as `mesh machines`.

## MM-2: Labels

- `Session.labels?: string[]` (max 10, topic syntax). Sources, merged, strongest last:
  1. repo default: `.mesh/agent.yaml` `labels: [...]` in the session's repo;
  2. `mesh run --label a,b`;
  3. `mesh label <session> a,b [--add|--rm]` or TUI key `L`.
  Labels set by 2 or 3 are remembered per cwd in the daemon store, so a new session in the same
  repo or worktree gets them.
- Machine labels: `mesh machine label a,b [--add|--rm]` (stored on the hub machine row, sent with sync).
- A label that is not a defined topic is accepted with a warning (`not a topic: perf; mesh topic add perf`).
- Labels are metadata and sync with the session (including `sessionMetadata`).
- Shown in `mesh machines`, the TUI, the web Mine tab and `/v1/live` sessions; `mesh machines --label perf` filters.

## MM-3: Assign (offers and accept)

**Data.** Step gains `offer?: { to: { machine: string; sid?: string }; by: string; bySid?: string;
byMachine?: string; at: number; state: "offered"|"accepted"|"declined"|"expired"|"withdrawn";
note?: string; decidedAt?: number }`. History is kept in events (`step.offered`, `step.accepted`,
`step.declined`, `step.offer_expired`, `step.offer_withdrawn`).

**Rules.**
- Only a `ready` step can be offered (a goal is offered through its design step; `--stick` also
  offers each step of the goal that becomes ready later to the same machine, until withdrawn).
- Who may assign: any member who may claim the step (goal owner, approver, admin, or anyone on a
  team goal, as for claim). The target is any online or offline machine of any user.
- While an offer is `offered`, only a session on the target machine (or the offering user) may claim
  the step; others get 409 `offered to <machine>`. Accept = that claim.
- Expiry: an offer not accepted within `offerExpiryMs` (hub threshold, default 30 min) expires: the
  step is plain ready again and the offerer gets an attention item and a message.
- `withdraw` by the offerer (or admin) returns the step to plain ready.
- `decline {note?}` by the target machine's owner or an accept-policy match.

**Accept policy.**
- Machine policy in daemon config `accept: ["self"]` (default), synced to the hub; per-session override
  with `mesh session accept <session> --from self,user:alice,machine:m1` or `--off`.
- The hub evaluates the policy when the offer is made: `self` matches when offerer = machine owner;
  `user:<id>`; `machine:<nickname|id>` matches the machine the offer was made from.
- Auto accept: the hub queues an inbox message `kind: "offer"` with `data: {step, auto: true, sid?}` to
  the target machine. The daemon picks the session: the named one if any; else an idle session in
  the step's repo, best label overlap with the goal's topics; then claims for it (`/claim` with that
  sid) and sends the brief like TUI `n` (waits for idle if the session is mid-turn: the existing
  pending-delivery queue). No idle session in the repo: if the machine has `assignments: "launch"`,
  the daemon starts `mesh run <repo> --step <id>` itself; otherwise the offer stays `offered` and shows
  in Assigned to you (and first in `mesh_next`).
- Manual: `data: {step, auto: false}`; nothing is claimed. Shown in **Assigned to you**:
  `mesh offers`, the TUI (badge + panel), the web Mine tab, `/v1/attention` (`kind: "offer"`), MCP
  `mesh_offers`. `mesh accept <step> [--session X | --launch]`, `mesh decline <step> [--note]`,
  MCP `mesh_accept {step}` (accepts for the calling session).
- Inbox messages today go to a session (`to_sid`); a machine-wide message uses `to_sid = ""` and the
  daemon handles it itself.

**Report back.** The offering session (`bySid`) gets messages on accepted (by which machine/session),
declined (note), expired, and later the step's done/failed/question. The goal page and `mesh show`
show the offer state per step ("offered to m2 → accepted by m2/perf-bench").

**Interfaces.**
- `POST /v1/steps/:id/assign {to: "<machine>[/<session>]", sid?, stick?, note?}` → `{step, auto}`;
  `<machine>` = nickname (of the caller first, then unique across users as `user/nickname`) or machine id;
  `<session>` = session name or sid prefix.
- `POST /v1/steps/:id/accept {sid?}`, `/decline {note?}`, `/withdraw`.
- `POST /v1/goals/:id/assign` = assign its ready design step (+ `stick`).
- `GET /v1/offers` (member): offers whose target machine belongs to the caller.
- CLI: `mesh assign <goal|step> --to m2[/session] [--stick] [--note]`, `mesh offers`, `mesh accept`,
  `mesh decline`, `mesh withdraw`. MCP: `mesh_assign {target, to, stick?}`, `mesh_offers`, `mesh_accept`.
- Daemon config `assignments: "deliver" | "launch" | "off"` (default `deliver`; `off` declines every
  offer automatically with a note).

## MM-4: Suggest and convenience

- `mesh assign <step|goal> --suggest` and `GET /v1/steps/:id/suggest`: candidates among my machines
  (and, with `--team`, everyone's), scored by: repo present (required unless `--any`), label overlap
  with the goal topics and step repo, machine labels, online, idle sessions, accept policy (auto
  ranks first). Each with a one-line reason.
- Web: an **Assign** button on a ready step and on a goal, with the ranked picker.
- `mesh say <machine>/<session> "text"`: send text to a session on another machine (existing
  `/v1/messages` with `toSid`; the CLI resolves the name).
- `maxSessions` (daemon config): `launch` never starts more than this many live sessions.

## Safety and privacy

- Metadata only leaves a machine for sessions without a step: no cwd, pane, transcript or text.
- `me` sessions are visible to their owner and admins only.
- Starting a process on a machine because of a hub message happens only with `assignments: "launch"`
  on that machine, and only for senders its policy accepts.
- Every offer, accept, decline, expiry and withdrawal is an event.

## Not in scope

- Attaching to a remote session's terminal.
- Offers across hubs.
- Splitting a goal across machines automatically (the plan's steps are offered one by one, or with `--stick`).
