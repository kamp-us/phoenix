/**
 * Report — the polymorphic content-report service. One canonical write surface
 * (`Report.submit`) for the three report targets: `definition`, `post`,
 * `comment`. Structurally mirrors {@link ../vote/Vote.ts | Vote} (a shared
 * low-level service over the same three targets, reached only through the
 * `Drizzle` seam, dying on infra errors via `orDieAccess`) minus the
 * `KarmaBump` contract — a report has no karma side-effect.
 *
 * Idempotency lives in the table: `content_report`'s composite PK
 * `(reporter_id, target_kind, target_id)` + `onConflictDoNothing` makes a
 * re-report by the same user a no-op success (the `user_vote` precedent). No
 * live view publishes off a write — a report is private moderation state.
 */
import {and, eq, inArray, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import type {TargetKind} from "../../db/target-kind.ts";
import {ReportTargetNotFound} from "./errors.ts";
import * as Resolution from "./resolution.ts";

// Re-exported from `db/target-kind.ts` (its source-of-truth home) for callers
// that prefer importing it from `./Report`.
export type {TargetKind};

export interface ReportInput {
	reporterId: string;
	targetKind: TargetKind;
	targetId: string;
	/** Optional free-text reason. */
	reason?: string | null;
}

export interface ReportResult {
	targetKind: TargetKind;
	targetId: string;
	/** `false` on idempotent no-op (the reporter already reported this target). */
	created: boolean;
}

/**
 * One row of the moderation queue (ADR 0098 §5): an open-reported target grouped
 * by `(targetKind, targetId)`, with the distinct-reporter count — the
 * repeat-offender / pile-on signal that comes free off the `content_report_target`
 * index. `reportCount` doubles as the count of open reports the resolve collapses.
 */
export interface OpenReportGroup {
	targetKind: TargetKind;
	targetId: string;
	/** Distinct reporters who have an OPEN report on this target. */
	reportCount: number;
	/** The earliest open report's reason (representative free-text), or null. */
	reason: string | null;
	/** When the first open report on this target landed (oldest-first queue order). */
	firstReportedAt: Date;
}

/**
 * The audit a terminal transition records (ADR 0098 §4). All three fields are
 * written together — there is no partial resolution.
 */
export interface ResolveTargetInput {
	targetKind: TargetKind;
	targetId: string;
	resolverId: string;
	/** The moderator's chosen action; the state machine derives the persisted outcome. */
	action: Resolution.ResolveAction;
	resolvedAt: Date;
}

export interface ResolveTargetResult {
	/** How many open reports on this target were collapsed in the batch. */
	collapsed: number;
}

export class Report extends Context.Service<
	Report,
	{
		readonly submit: (input: ReportInput) => Effect.Effect<ReportResult, ReportTargetNotFound>;
		/**
		 * Batched presence read: the subset of `targetIds` the viewer already has a
		 * `content_report` row for, of the given `kind`, in one `IN (...)` read so
		 * callers stamp "already reported" without an N+1. Missing viewer or empty
		 * `targetIds` short-circuits to an empty Set with no read.
		 */
		readonly readByReporter: (
			viewerId: string | null | undefined,
			kind: TargetKind,
			targetIds: ReadonlyArray<string>,
		) => Effect.Effect<Set<string>>;

		/**
		 * The moderation queue (ADR 0098 §5): open reports grouped by target,
		 * oldest-first, each carrying its distinct-reporter (repeat-offender) count.
		 * Private moderation state — the resolver gates it behind `Moderator.required`.
		 */
		readonly listOpen: (opts?: {limit?: number}) => Effect.Effect<ReadonlyArray<OpenReportGroup>>;

		/**
		 * Terminal transition (ADR 0098 §3/§4): collapse EVERY open report on
		 * `(targetKind, targetId)` to the decided terminal status in one batch,
		 * stamping the audit triad (`resolverId`/`resolvedAt`/`resolution`) on each.
		 * Idempotent: zero open reports ⇒ `collapsed: 0`, no write. The author-side
		 * authority check lives in the resolver (`Moderator.required`), not here.
		 */
		readonly resolveTarget: (input: ResolveTargetInput) => Effect.Effect<ResolveTargetResult>;

		/**
		 * Reopen (ADR 0098 §3): flip every resolved/dismissed report on the target
		 * back to `open`, clearing its audit triad — the restore-reopens-its-report
		 * edge (ADR 0096 §4). Returns how many reports were reopened.
		 */
		readonly reopenForTarget: (input: {
			targetKind: TargetKind;
			targetId: string;
		}) => Effect.Effect<{reopened: number}>;

		/**
		 * Resolve a single report id to its `(targetKind, targetId)` — so the resolve
		 * mutation accepts a `reportId` and acts on its whole target group (ADR 0098).
		 * `null` when no such report exists.
		 */
		readonly lookupReportTarget: (
			reportId: string,
		) => Effect.Effect<{targetKind: TargetKind; targetId: string} | null>;

		/**
		 * The earliest OPEN report id on a target — the representative report the
		 * `Moderated({reportId})` removal reason links to, so a later restore reopens
		 * the whole group. `null` when no open report exists on the target.
		 */
		readonly firstOpenReportId: (
			targetKind: TargetKind,
			targetId: string,
		) => Effect.Effect<string | null>;
	}
>()("@kampus/report/Report") {}

export const ReportLive = Layer.effect(Report)(
	Effect.gen(function* () {
		// `orDieAccess`: every internal DB call site dies on `DrizzleError` (infra
		// failures are defects), so public signatures carry domain errors only and
		// `R` stays `never`. See ADR 0013/0014, `.patterns/feature-services.md`.
		const {run} = orDieAccess(yield* Drizzle);

		// Validate the target exists and is not soft-deleted. Surfaces
		// `ReportTargetNotFound` rather than letting the insert fail FK-shaped.
		const assertTargetLive = Effect.fn("Report.assertTargetLive")(function* (
			kind: TargetKind,
			targetId: string,
		) {
			const exists = yield* run((db) => {
				switch (kind) {
					case "definition":
						return db.query.definitionRecord.findFirst({
							where: {id: targetId, removedAt: {isNull: true}},
							columns: {id: true},
						});
					case "post":
						return db.query.postRecord.findFirst({
							where: {id: targetId, removedAt: {isNull: true}},
							columns: {id: true},
						});
					case "comment":
						return db.query.commentRecord.findFirst({
							where: {id: targetId, removedAt: {isNull: true}},
							columns: {id: true},
						});
				}
			});
			if (!exists) {
				return yield* new ReportTargetNotFound({
					targetKind: kind,
					targetId,
					message: `report target ${kind} ${targetId} not found`,
				});
			}
		});

		const readByReporter = Effect.fn("Report.readByReporter")(function* (
			viewerId: string | null | undefined,
			kind: TargetKind,
			targetIds: ReadonlyArray<string>,
		) {
			if (!viewerId || targetIds.length === 0) return new Set<string>();
			const rows = yield* run((db) =>
				db
					.select({targetId: schema.contentReport.targetId})
					.from(schema.contentReport)
					.where(
						and(
							eq(schema.contentReport.reporterId, viewerId),
							eq(schema.contentReport.targetKind, kind),
							inArray(schema.contentReport.targetId, [...targetIds]),
						),
					),
			);
			return new Set(rows.map((r) => r.targetId));
		});

		const listOpen = Effect.fn("Report.listOpen")(function* (opts?: {limit?: number}) {
			const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
			const rows = yield* run((db) =>
				db
					.select({
						targetKind: schema.contentReport.targetKind,
						targetId: schema.contentReport.targetId,
						reportCount: sql<number>`COUNT(*)`,
						firstReportedAt: sql<number>`MIN(${schema.contentReport.createdAt})`,
						reason: sql<string | null>`MIN(${schema.contentReport.reason})`,
					})
					.from(schema.contentReport)
					.where(eq(schema.contentReport.status, "open"))
					.groupBy(schema.contentReport.targetKind, schema.contentReport.targetId)
					.orderBy(sql`MIN(${schema.contentReport.createdAt}) ASC`)
					.limit(limit),
			);
			return rows.map(
				(r) =>
					({
						targetKind: r.targetKind as TargetKind,
						targetId: r.targetId,
						reportCount: Number(r.reportCount),
						reason: r.reason ?? null,
						// D1 stores `created_at` as integer seconds (timestamp mode); MIN
						// returns that raw value, so reconstruct the Date from seconds.
						firstReportedAt: new Date(Number(r.firstReportedAt) * 1000),
					}) satisfies OpenReportGroup,
			);
		});

		const resolveTarget = Effect.fn("Report.resolveTarget")(function* (input: ResolveTargetInput) {
			// The terminal status AND the persisted outcome are decided by the state
			// machine (open → resolved/removed | dismissed/dismissed); the `status='open'`
			// WHERE guard below is the SQL-level counterpart that makes the transition
			// apply only to open rows.
			const {status, resolution} = Resolution.resolve("open", input.action);
			const result = yield* run((db) =>
				db
					.update(schema.contentReport)
					.set({
						status,
						resolverId: input.resolverId,
						resolvedAt: input.resolvedAt,
						resolution,
					})
					.where(
						and(
							eq(schema.contentReport.targetKind, input.targetKind),
							eq(schema.contentReport.targetId, input.targetId),
							eq(schema.contentReport.status, "open"),
						),
					)
					.run(),
			);
			return {collapsed: result.meta.changes} satisfies ResolveTargetResult;
		});

		const reopenForTarget = Effect.fn("Report.reopenForTarget")(function* (input: {
			targetKind: TargetKind;
			targetId: string;
		}) {
			const result = yield* run((db) =>
				db
					.update(schema.contentReport)
					.set({status: "open", resolverId: null, resolvedAt: null, resolution: null})
					.where(
						and(
							eq(schema.contentReport.targetKind, input.targetKind),
							eq(schema.contentReport.targetId, input.targetId),
							inArray(schema.contentReport.status, ["resolved", "dismissed"]),
						),
					)
					.run(),
			);
			return {reopened: result.meta.changes};
		});

		const lookupReportTarget = Effect.fn("Report.lookupReportTarget")(function* (reportId: string) {
			const row = yield* run((db) =>
				db
					.select({
						targetKind: schema.contentReport.targetKind,
						targetId: schema.contentReport.targetId,
					})
					.from(schema.contentReport)
					.where(eq(schema.contentReport.id, reportId))
					.limit(1)
					.get(),
			);
			if (!row) return null;
			return {targetKind: row.targetKind as TargetKind, targetId: row.targetId};
		});

		const firstOpenReportId = Effect.fn("Report.firstOpenReportId")(function* (
			targetKind: TargetKind,
			targetId: string,
		) {
			const row = yield* run((db) =>
				db
					.select({id: schema.contentReport.id})
					.from(schema.contentReport)
					.where(
						and(
							eq(schema.contentReport.targetKind, targetKind),
							eq(schema.contentReport.targetId, targetId),
							eq(schema.contentReport.status, "open"),
						),
					)
					.orderBy(sql`${schema.contentReport.createdAt} ASC`)
					.limit(1)
					.get(),
			);
			return row?.id ?? null;
		});

		return {
			readByReporter,
			listOpen,
			resolveTarget,
			reopenForTarget,
			lookupReportTarget,
			firstOpenReportId,
			submit: Effect.fn("Report.submit")(function* (input: ReportInput) {
				yield* assertTargetLive(input.targetKind, input.targetId);

				// Idempotent on the composite PK: a re-report by the same reporter on
				// the same target is a no-op success (`changes === 0`). A fresh `id`
				// on a conflicting insert never lands, so it's harmless.
				const result = yield* run((db) =>
					db
						.insert(schema.contentReport)
						.values({
							id: crypto.randomUUID(),
							reporterId: input.reporterId,
							targetKind: input.targetKind,
							targetId: input.targetId,
							reason: input.reason ?? null,
							status: "open",
							createdAt: new Date(),
						})
						.onConflictDoNothing()
						.run(),
				);

				return {
					targetKind: input.targetKind,
					targetId: input.targetId,
					created: result.meta.changes > 0,
				} satisfies ReportResult;
			}),
		};
	}),
);
