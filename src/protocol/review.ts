import { z } from "zod";

// RL-2: review records, items, dispositions, lineage and fold. Self-contained (imports only zod):
// goal.ts imports from here, so this module never imports goal.ts.

/** `S1` is the most severe; "at or above S2" means S1 or S2. */
export const Severity = z.enum(["S1", "S2", "S3", "S4"]);
export type Severity = z.infer<typeof Severity>;

export const ItemState = z.enum(["open", "confirmed", "dismissed", "deferred", "accepted", "resolved"]);
export type ItemState = z.infer<typeof ItemState>;

export const Disposition = z.enum(["confirmed", "dismissed", "deferred", "accepted"]);
export type Disposition = z.infer<typeof Disposition>;

export const FoldMark = z.enum(["new", "repeat", "regression", "resolved"]);
export type FoldMark = z.infer<typeof FoldMark>;

const count = z.number().int().min(0);
export const Fold = z.object({ new: count, repeat: count, regression: count, resolved: count, carried: count });
export type Fold = z.infer<typeof Fold>;

/** When a conditional stage runs: at least one consumed item (at or above `min_severity`). */
export const StepWhen = z.object({ open: z.literal(true).optional(), min_severity: Severity.optional() }).strict();
export type StepWhen = z.infer<typeof StepWhen>;

export const ReviewEvidence = z
  .object({
    path: z.string().min(1).max(500),
    lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
    note: z.string().max(1000).optional(),
  })
  .strict()
  .refine((e) => !e.lines || e.lines[0] <= e.lines[1], { message: "lines must be [start, end] with start ≤ end", path: ["lines"] });
export type ReviewEvidence = z.infer<typeof ReviewEvidence>;

/** What makes an item's identity (its fingerprint): never line numbers. */
export const ReviewKey = z
  .object({ rule: z.string().min(1).max(80), path: z.string().min(1).max(500).optional(), symbol: z.string().min(1).max(200).optional() })
  .strict();
export type ReviewKey = z.infer<typeof ReviewKey>;

export const ReviewItem = z
  .object({
    key: ReviewKey,
    title: z.string().min(1).max(200),
    severity: Severity,
    category: z.string().min(1).max(60),
    evidence: z.array(ReviewEvidence).max(20),
    proposal: z.string().max(4000).optional(),
  })
  .strict();
export type ReviewItem = z.infer<typeof ReviewItem>;

export const RecordDisposition = z
  .object({
    fingerprint: z.string().regex(/^[a-z2-7]{16}$/, "a fingerprint is 16 characters of a-z and 2-7"),
    disposition: Disposition,
    reason: z.string().min(1).max(2000),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "until is a date YYYY-MM-DD").optional(),
    link: z.string().min(1).max(500).optional(),
  })
  .strict();
export type RecordDisposition = z.infer<typeof RecordDisposition>;

export const ReviewSubject = z
  .object({ repo: z.string().max(300).optional(), commit: z.string().max(64).optional(), artifact: z.string().max(40).optional() })
  .strict();
export type ReviewSubject = z.infer<typeof ReviewSubject>;

export const ReviewRecord = z
  .object({
    subject: ReviewSubject.default({}),
    coverage: z.enum(["complete", "partial"]),
    scope: z.array(z.string().min(1).max(500)).max(200).optional(),
    assessment: z.enum(["clean", "issues", "blocked"]),
    items: z.array(ReviewItem).max(500),
    dispositions: z.array(RecordDisposition).max(500).default([]),
    summary: z.string().min(1).max(8000),
  })
  .strict();
export type ReviewRecord = z.infer<typeof ReviewRecord>;

export const StoredReviewItem = ReviewItem.extend({
  fp: z.string(),
  eh: z.string().optional(),
  mark: z.enum(["new", "repeat", "regression"]).optional(),
});
export type StoredReviewItem = z.infer<typeof StoredReviewItem>;

export const StoredRecord = ReviewRecord.extend({ items: z.array(StoredReviewItem) });
export type StoredRecord = z.infer<typeof StoredRecord>;

export const Decider = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), key: z.string(), hash: z.string().optional() }),
  z.object({ kind: z.literal("person"), user: z.string() }),
]);
export type Decider = z.infer<typeof Decider>;

export const StoredReview = z.object({
  goal: z.string(),
  step: z.string(),
  round: z.number().int().min(1),
  /** The lineage key `<preset>|<repo>|<agent>`. */
  lineage: z.string(),
  raising: z.boolean(),
  /** `coverage === "complete"`. */
  complete: z.boolean(),
  record: StoredRecord,
  fold: Fold.optional(),
  /** The id of the record's `review` artifact. */
  artifact: z.string(),
  undeclaredRules: z.number().int().min(0),
  decider: Decider,
  /** The submitting user. */
  by: z.string(),
  sid: z.string().optional(),
  at: z.number(),
});
export type StoredReview = z.infer<typeof StoredReview>;

/** RL-4: how a disposition was recorded: in a stage's review record, or one at a time in a debrief. */
export const DispositionVia = z.enum(["stage", "debrief-session"]);
export type DispositionVia = z.infer<typeof DispositionVia>;

const HistoryBase = z.object({
  at: z.number(),
  goal: z.string(),
  step: z.string(),
  round: z.number().int(),
  from: ItemState.nullable(),
  to: ItemState,
});
const FoldEntry = z.object({ kind: z.literal("fold"), mark: FoldMark, carried: z.literal(true).optional() });
const DispositionEntry = z.object({
  kind: z.literal("disposition"),
  disposition: Disposition,
  reason: z.string(),
  decider: Decider,
  via: DispositionVia,
  /** RL-4: the person's own words (debrief dispositions recorded with mesh_dispose). */
  answer: z.string().optional(),
  link: z.string().optional(),
  until: z.string().optional(),
});
/** RL-4: a debrief disposition undone from the UI (`from` = the reverted state, `to` = the restored one). */
const RevertEntry = z.object({
  kind: z.literal("revert"),
  disposition: Disposition,
  decider: z.object({ kind: z.literal("person"), user: z.string() }),
  via: z.literal("ui"),
  reason: z.string().optional(),
});
export const ItemHistoryEntry = HistoryBase.and(z.discriminatedUnion("kind", [FoldEntry, DispositionEntry, RevertEntry]));
export type ItemHistoryEntry = z.infer<typeof ItemHistoryEntry>;

export const DispositionRow = z.object({
  lineage: z.string(),
  fp: z.string(),
  goal: z.string(),
  step: z.string(),
  round: z.number().int(),
  disposition: Disposition,
  from: ItemState,
  reason: z.string(),
  decider: Decider,
  via: DispositionVia,
  answer: z.string().optional(),
  link: z.string().optional(),
  until: z.string().optional(),
  at: z.number(),
});
export type DispositionRow = z.infer<typeof DispositionRow>;

const Seen = z.object({ goal: z.string(), step: z.string(), round: z.number().int(), at: z.number() });

/** An item row as the hub stores it: `ItemView` without `history`. */
export const ItemRow = z.object({
  lineage: z.string(),
  fp: z.string(),
  state: ItemState,
  rule: z.string(),
  path: z.string().optional(),
  symbol: z.string().optional(),
  title: z.string(),
  severity: Severity,
  category: z.string(),
  eh: z.string().optional(),
  dismissedEh: z.string().optional(),
  until: z.string().optional(),
  link: z.string().optional(),
  raisedBy: z.object({ key: z.string(), hash: z.string().optional() }),
  first: Seen,
  last: Seen,
});
export type ItemRow = z.infer<typeof ItemRow>;

export const ItemView = ItemRow.extend({ history: z.array(ItemHistoryEntry) });
export type ItemView = z.infer<typeof ItemView>;
