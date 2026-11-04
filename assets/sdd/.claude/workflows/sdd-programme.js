export const meta = {
  name: 'sdd-programme',
  description: 'Spec-driven development for one or more rows, unattended: spec and a cold review loop, implementation and test plans written apart, developer and test-writer in separate worktrees (fail-first tests), combine, a read-only verify loop with fixes routed by failure bucket, a cold diff review. Parks a row instead of guessing.',
  whenToUse: 'Run a programme of rows (work items) through the whole cycle. args: {rows: [{key, title, brief}], base?: "main", maxSpecRounds?: 3, maxCycles?: 3, maxDiffRounds?: 2, specDir?: "specs", planDir?: "plans", reviewDir?: "reviews"}. key is your own id for the row (e.g. ROW-42); it names the files and labels.',
  phases: [
    { title: 'Spec', detail: 'spec-writer, cold reviewer, at most maxSpecRounds rounds' },
    { title: 'Plan', detail: 'impl-planner and test-planner in parallel, never sharing' },
    { title: 'Build', detail: 'developer and test-writer in separate worktrees; combine' },
    { title: 'Verify', detail: 'read-only test-executor; fixes routed by bucket, at most maxCycles' },
    { title: 'Review', detail: 'cold diff review, at most maxDiffRounds' },
    { title: 'Ledger', detail: 'mesh ledger stage, when mesh is installed' },
  ],
}

// Shipped with mesh-harness (assets/sdd; install with `mesh assets install`). It needs nothing from
// mesh: every agent() call has a label <role>:<key>[:<round>] and a typed result (schema), which mesh,
// when present, reads from Claude Code's own workflow files to write the ledger. Without mesh the
// programme runs the same.

const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
if (!Array.isArray(A.rows) || A.rows.length === 0) throw new Error('sdd-programme: args.rows is required: [{key, title, brief}]')
const BASE = A.base || 'main'
const SPEC_ROUNDS = A.maxSpecRounds || 3
const CYCLES = A.maxCycles || 3
const DIFF_ROUNDS = A.maxDiffRounds || 2
const SPECS = A.specDir || 'specs'
const PLANS = A.planDir || 'plans'
const REVIEWS = A.reviewDir || 'reviews'

const COMMON = `Repo rules: CLAUDE.md and .claude/agents/<your role>.md. UNATTENDED: never wait for a person; write each open question into the spec's Open questions section and continue on the conservative reading. Stage files by name (never git add -A). Name every check you ran and every one you did not.`

const DOC = { type: 'object', properties: { path: { type: 'string' }, acceptance_criteria: { type: 'array', items: { type: 'string' } }, open_questions: { type: 'array', items: { type: 'string' } } }, required: ['path', 'acceptance_criteria'] }
const REVIEW = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'CHANGES REQUESTED', 'BLOCKED'] },
    round_file: { type: 'string' },
    blocking_open: { type: 'number' },
    findings: { type: 'number' },
    findings_new: { type: 'number' },
    findings_repeat: { type: 'number' },
    regression_of_own_repair: { type: 'number' },
    impl_findings: { type: 'array', items: { type: 'string' } },
    test_findings: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'blocking_open'],
}
const CRITERIA = { type: 'array', items: { type: 'string' }, description: 'acceptance criterion ids (AC-01, ...) this work covers' }
const PLAN = { type: 'object', properties: { path: { type: 'string' }, criteria: CRITERIA }, required: ['path', 'criteria'] }
const BRANCH = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['Completed', 'Stopped'] }, branch: { type: 'string' }, head: { type: 'string' }, criteria: CRITERIA, not_fail_first: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } },
  required: ['status', 'branch'],
}
const MERGE = { type: 'object', properties: { merged: { type: 'boolean' }, head: { type: 'string' }, note: { type: 'string' } }, required: ['merged'] }
const TEST = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    criteria: { type: 'array', items: { type: 'object', properties: { criterion: { type: 'string' }, state: { type: 'string', enum: ['pass', 'fail', 'unrun'] }, surface: { type: 'string' } }, required: ['criterion', 'state'] } },
    failing: { type: 'array', items: { type: 'object', properties: { criterion: { type: 'string' }, bucket: { type: 'string', enum: ['spec-gap', 'impl-bug', 'test-bug', 'infra'] }, note: { type: 'string' } }, required: ['bucket'] } },
    self_check_clean: { type: 'boolean' },
  },
  required: ['verdict', 'self_check_clean'],
}
const OK = { type: 'object', properties: { ok: { type: 'boolean' }, staged: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } }, required: ['ok'] }

async function row(r) {
  const K = r.key
  const out = { key: K, state: 'parked' }
  const park = (reason) => Object.assign(out, { reason })
  const spec = `${SPECS}/${K}.md`

  // ---- Spec: writer, then a cold reviewer; the reviewer reads the record, never the writer's session.
  phase('Spec')
  let doc = await agent(`${COMMON}\n\nRead .claude/agents/spec-writer.md and follow it to write ${spec} for: ${r.title}. ${r.brief || ''}\nCommit it.`, { label: `spec-writer:${K}`, phase: 'Spec', agentType: 'spec-writer', schema: DOC })
  if (!doc) return park('spec-writer returned nothing')
  let rev = null
  for (let round = 1; round <= SPEC_ROUNDS; round++) {
    rev = await agent(`${COMMON}\n\nRead .claude/agents/reviewer.md and review ${doc.path} cold, round ${round} of ${SPEC_ROUNDS}. Read ${REVIEWS}/${K}/ first if it exists, oldest round first. Classify each finding NEW / REPEAT / REGRESSION-OF-OWN-REPAIR. Write ${REVIEWS}/${K}/r${round}-<verdict>.md and commit that file only.`, { label: `reviewer:${K}:r${round}`, phase: 'Spec', agentType: 'reviewer', schema: REVIEW })
    if (!rev) return park('reviewer returned nothing')
    if (rev.verdict === 'APPROVED') break
    if (rev.findings && (rev.regression_of_own_repair || 0) * 2 > rev.findings) return park(`churn at review round ${round}`)
    if (round === SPEC_ROUNDS) return park(`spec not approved after ${round} rounds`)
    doc = (await agent(`${COMMON}\n\nRead .claude/agents/spec-writer.md. Revise ${doc.path} for the blockers in ${REVIEWS}/${K}/ (newest round). ${round === SPEC_ROUNDS - 1 ? 'Last repair: fix blockers only, add no new material.' : ''} Commit.`, { label: `spec-writer:${K}:v${round + 1}`, phase: 'Spec', agentType: 'spec-writer', schema: DOC })) || doc
  }
  const acs = doc.acceptance_criteria || []

  // ---- Plans, in parallel: the test side plans from the spec's contracts alone.
  phase('Plan')
  const [impl, tplan] = await parallel([
    () => agent(`${COMMON}\n\nRead .claude/agents/impl-planner.md. Spec: ${doc.path}. Write ${PLANS}/${K}-impl-plan.md, one section per acceptance criterion. Do not plan the tests. Commit it on branch impl/${K} (create it from ${BASE} if needed); never on the test branch.`, { label: `impl-planner:${K}`, phase: 'Plan', agentType: 'impl-planner', schema: PLAN }),
    () => agent(`${COMMON}\n\nRead .claude/agents/test-planner.md. Spec: ${doc.path}. Do NOT read any implementation plan or implementation source. Write ${PLANS}/${K}-test-plan.md: per criterion the state that makes it fail, a positive control and a mutation. Commit it on branch test/${K} (create it from ${BASE} if needed); never on the implementation branch.`, { label: `test-planner:${K}`, phase: 'Plan', agentType: 'test-planner', schema: PLAN }),
  ])
  if (!impl || !tplan) return park('a planner returned nothing')
  const missing = acs.filter((a) => !(tplan.criteria || []).includes(a))
  if (missing.length) return park(`reconcile: the test plan misses ${missing.join(', ')}`)

  // ---- Build: each side in its own worktree; the test-writer starts from the pre-change base.
  phase('Build')
  let [dev, tw] = await parallel([
    () => agent(`${COMMON}\n\nRead .claude/agents/developer.md. Spec: ${doc.path}. Plan: ${PLANS}/${K}-impl-plan.md on branch impl/${K}. Work on branch impl/${K} in your worktree; commit there. Never create or edit a test. Never read branch test/${K}.`, { label: `developer:${K}`, phase: 'Build', agentType: 'developer', isolation: 'worktree', schema: BRANCH }),
    () => agent(`${COMMON}\n\nRead .claude/agents/test-writer.md. Spec: ${doc.path}. Plan: ${PLANS}/${K}-test-plan.md on branch test/${K}. Work on branch test/${K} in your worktree, from ${BASE} (the pre-change baseline); commit there. Never read implementation source, the implementation plan or branch impl/${K}. FAIL-FIRST: run every new test here and list each one that did not fail.`, { label: `test-writer:${K}`, phase: 'Build', agentType: 'test-writer', isolation: 'worktree', schema: BRANCH }),
  ])
  if (!dev || !tw) return park('developer or test-writer returned nothing')
  if (dev.status === 'Stopped') return park(`developer stopped: ${dev.note || ''}`)
  const combine = async (n) => {
    const round = n > 1 ? ':c' + n : ''
    return agent(`${COMMON}\n\nRead .claude/agents/merger.md. Merge branch ${tw.branch} into ${dev.branch} (git merge --no-ff), in a worktree of ${dev.branch}. No other edit. On a conflict: git merge --abort and report merged=false with the paths.`, { label: `merger:${K}${round}`, phase: 'Build', agentType: 'merger', schema: MERGE })
  }
  let comb = await combine(1)
  if (!comb || !comb.merged) return park(`combine failed: ${comb ? comb.note : 'no answer'} (one side touched the other's files)`)

  // ---- Verify: read-only; each failure has a bucket that decides who fixes it.
  phase('Verify')
  let test = null
  let best = -1
  let stale = 0
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    test = await agent(`${COMMON}\n\nRead .claude/agents/test-executor.md. Spec: ${doc.path}. Test plan: ${PLANS}/${K}-test-plan.md. Branch ${dev.branch} (combined). You are READ-ONLY on all code and tests; run git status --porcelain last. Judge every criterion pass / fail / unrun with the surface it ran on; bucket each failure.`, { label: `test-executor:${K}:c${cycle}`, phase: 'Verify', agentType: 'test-executor', schema: TEST })
    if (!test) return park('test-executor returned nothing')
    if (!test.self_check_clean) return park('test-executor changed a file; the run is void')
    if (test.verdict === 'PASS') break
    const passing = (test.criteria || []).filter((c) => c.state === 'pass').length
    if (passing > best) { best = passing; stale = 0 } else stale++
    if (cycle === CYCLES || stale >= 2) return park(`verify did not pass after ${cycle} cycle(s)`)
    const buckets = new Set((test.failing || []).map((f) => f.bucket))
    if (buckets.has('spec-gap') || buckets.has('infra')) return park(`verify: ${[...buckets].join(', ')} needs a person`)
    // The fixer gets the criterion, bucket and note only, never the tester's whole report.
    const only = (b) => JSON.stringify((test.failing || []).filter((f) => f.bucket === b).map((f) => ({ criterion: f.criterion, note: f.note })))
    if (buckets.has('impl-bug')) dev = (await agent(`${COMMON}\n\nRead .claude/agents/developer.md. Fix these on branch ${dev.branch}; commit there; never touch a test: ${only('impl-bug')}`, { label: `developer:${K}:fix${cycle}`, phase: 'Verify', agentType: 'developer', isolation: 'worktree', schema: BRANCH })) || dev
    if (buckets.has('test-bug')) tw = (await agent(`${COMMON}\n\nRead .claude/agents/test-writer.md. Fix these on branch ${tw.branch}; commit there; never read implementation source; each changed test still fails first on ${BASE}: ${only('test-bug')}`, { label: `test-writer:${K}:fix${cycle}`, phase: 'Verify', agentType: 'test-writer', isolation: 'worktree', schema: BRANCH })) || tw
    comb = await combine(cycle + 1)
    if (!comb || !comb.merged) return park('combine failed after a fix')
  }

  // ---- Diff review, cold.
  phase('Review')
  let diff = null
  for (let round = 1; round <= DIFF_ROUNDS; round++) {
    diff = await agent(`${COMMON}\n\nRead .claude/agents/reviewer.md and review the DIFF git diff ${BASE}...${dev.branch} against ${doc.path}, round ${round}. Check: every criterion has a test that failed first, no assertion on source text, the developer changed no test and the test-writer no product code. Write ${REVIEWS}/${K}/diff-r${round}-<verdict>.md and commit it. Split findings into impl_findings and test_findings.`, { label: `reviewer:${K}:diff${round}`, phase: 'Review', agentType: 'reviewer', schema: REVIEW })
    if (!diff || diff.verdict === 'APPROVED') break
    if (round === DIFF_ROUNDS) return park(`diff review not approved after ${round} rounds`)
    if ((diff.impl_findings || []).length) dev = (await agent(`${COMMON}\n\nRead .claude/agents/developer.md. Fix on ${dev.branch}; never touch a test: ${JSON.stringify(diff.impl_findings)}`, { label: `developer:${K}:rfix${round}`, phase: 'Review', agentType: 'developer', isolation: 'worktree', schema: BRANCH })) || dev
    if ((diff.test_findings || []).length) tw = (await agent(`${COMMON}\n\nRead .claude/agents/test-writer.md. Fix on ${tw.branch}; never read implementation source: ${JSON.stringify(diff.test_findings)}`, { label: `test-writer:${K}:rfix${round}`, phase: 'Review', agentType: 'test-writer', isolation: 'worktree', schema: BRANCH })) || tw
    comb = await combine(CYCLES + round + 1)
    if (!comb || !comb.merged) return park('combine failed after review fixes')
  }
  if (!diff || diff.verdict !== 'APPROVED') return park('diff review not approved')
  return Object.assign(out, { state: 'ready to land', branch: dev.branch, head: comb.head, criteria: (test && test.criteria) || [] })
}

const results = []
for (const r of A.rows) {
  log(`row ${r.key}`)
  results.push(await row(r))
}

// ---- Ledger: with mesh installed, its records of this run are staged and committed; without, nothing.
phase('Ledger')
const keys = results.map((x) => x.key).join(' ')
const led = await agent(`If the command mesh exists (command -v mesh), run: mesh ledger stage ${keys} — then git add, by name, exactly the paths it printed, and commit them with message "ledger: ${keys}". If mesh is missing or prints nothing, do nothing. Change no other file.`, { label: 'ledger', phase: 'Ledger', schema: OK, effort: 'low' })

return { rows: results, ledger: led, note: 'Nothing was pushed or merged. Rows "ready to land" wait for a person (R3); parked rows say why.' }
