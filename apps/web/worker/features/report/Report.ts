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
import {and, eq, inArray, isNotNull, isNull, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import type {TargetKind} from "../../db/target-kind.ts";
import {targetTable} from "../../db/target-table.ts";
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
 * One row of the shared decision feed (#1704, the two-person team-ledger): a
 * resolved/dismissed target grouped by `(targetKind, targetId)`, carrying the audit
 * triad `content_report` stamps on a terminal transition — the decision
 * (`removed`/`dismissed`), the **resolver** (which moderator), and when. Because
 * `resolveTarget` stamps every open row on a target with one uniform triad (and
 * `reopenForTarget` clears it), a target's terminal rows share a single decision, so
 * the group carries one resolver/resolution/resolvedAt. `resolvedAt` is the group's
 * most-recent terminal stamp — the decision feed's newest-first order.
 */
export interface ResolvedReportGroup {
	targetKind: TargetKind;
	targetId: string;
	/** The decision the resolver made — `removed` (content soft-deleted) | `dismissed`. */
	resolution: Resolution.Resolution;
	/** The moderator who decided — first-class in the two-person ledger, never a footnote. */
	resolverId: string;
	/** When the decision landed (most-recent terminal stamp; newest-first feed order). */
	resolvedAt: Date;
	/** How many reports the decision collapsed on this target. */
	reportCount: number;
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
	/**
	 * The wave-remove grouping identity (#1855, ADR 0138): the shared id stamped on
	 * this resolve when it is one target of a wave gesture, so the batch reopens as a
	 * unit (`reopenForWave`). Omitted/`null` on a single-target resolve — a wave
	 * groups a batch, a lone resolve has none.
	 */
	waveId?: string | null;
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
		 * Private moderation state — the resolver gates it behind the `Moderate`
		 * capability (`requireModeration`, ADR 0107 §4).
		 */
		readonly listOpen: (opts?: {limit?: number}) => Effect.Effect<ReadonlyArray<OpenReportGroup>>;

		/**
		 * The shared decision feed (#1704): recently resolved/dismissed targets grouped
		 * by target, newest-decision-first, each carrying the audit triad (decision,
		 * resolver, resolved-at). Bounded single-page like {@link listOpen} (no cursor).
		 * Private moderation state — the resolver gates it behind `Moderate`.
		 */
		readonly listResolved: (opts?: {
			limit?: number;
		}) => Effect.Effect<ReadonlyArray<ResolvedReportGroup>>;

		/**
		 * Terminal transition (ADR 0098 §3/§4): collapse EVERY open report on
		 * `(targetKind, targetId)` to the decided terminal status in one batch,
		 * stamping the audit triad (`resolverId`/`resolvedAt`/`resolution`) on each.
		 * Idempotent: zero open reports ⇒ `collapsed: 0`, no write. The author-side
		 * authority check lives in the resolver (`requireModeration` discharging the
		 * `Moderate` capability), not here.
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
		 * Reopen a whole wave as a unit (#1855, ADR 0138): flip every resolved/dismissed
		 * report sharing `waveId` back to `open`, clearing its audit triad + the wave
		 * grouping — the restore-as-a-unit primitive #1704's restore mutation calls. One
		 * shared id, so the batch reopens together and nothing outside it is touched.
		 * Returns how many reports were reopened.
		 */
		readonly reopenForWave: (waveId: string) => Effect.Effect<{reopened: number}>;

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

		/**
		 * The moderation-queue reputation join (#1703, ADR 0138): for each author id,
		 * how many of their content targets a moderator has previously removed
		 * (`removed_by IS NOT NULL` across the post/comment/definition record tables).
		 * One batched read over the page's authors, keyed by author id — the
		 * repeat-offender signal the triage row surfaces. Absent authors carry 0.
		 */
		readonly countRemovalsByAuthors: (
			authorIds: ReadonlyArray<string>,
		) => Effect.Effect<ReadonlyMap<string, number>>;

		/**
		 * The pile-on's reporter-diversity numerator (#1703): per target, the total open
		 * reports and the DISTINCT reporters behind them, keyed by `<kind>:<id>`. The
		 * composite report PK collapses them for content targets today (one reporter,
		 * one target), so the counts equal — the shape is threaded now for #1855's
		 * remove-the-wave, which distinguishes a real wave from a grudge-reporter.
		 */
		readonly reporterDiversity: (
			targets: ReadonlyArray<{targetKind: TargetKind; targetId: string}>,
		) => Effect.Effect<ReadonlyMap<string, {reportCount: number; distinctReporters: number}>>;

		/**
		 * The actor-drawer's üretim counts (#1852, ADR 0138): per author, how many
		 * definition / post / comment records they authored (`removed_at IS NULL` — live
		 * production only). One grouped read per kind over the page's authors, keyed by
		 * author id; absent authors carry a zeroed triple. The künye-join actor-drawer
		 * renders these as the actor's content footprint alongside their standing.
		 */
		readonly productionCountsByAuthors: (
			authorIds: ReadonlyArray<string>,
		) => Effect.Effect<ReadonlyMap<string, ProductionCounts>>;

		/**
		 * The actor-drawer's "bu aktör" tell (#1852, ADR 0138): per author, how many
		 * DISTINCT of their targets carry an open report — the count behind "this actor
		 * has N reported targets", the entry point #1855's remove-the-wave grows from.
		 * Joined via the author id the content read captured; one grouped read per kind
		 * over the page's authors. Absent authors carry 0.
		 */
		readonly countOpenReportedTargetsByAuthors: (
			authorIds: ReadonlyArray<string>,
		) => Effect.Effect<ReadonlyMap<string, number>>;
	}
>()("@kampus/report/Report") {}

/** The actor's live content footprint (#1852) — per-kind production counts. */
export interface ProductionCounts {
	definitionCount: number;
	postCount: number;
	commentCount: number;
}

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
			const meta = yield* run((db) => targetTable[kind].loadMeta(db, targetId));
			if (!meta) {
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

		const listResolved = Effect.fn("Report.listResolved")(function* (opts?: {limit?: number}) {
			const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
			const rows = yield* run((db) =>
				db
					.select({
						targetKind: schema.contentReport.targetKind,
						targetId: schema.contentReport.targetId,
						reportCount: sql<number>`COUNT(*)`,
						resolvedAt: sql<number>`MAX(${schema.contentReport.resolvedAt})`,
						// A target's terminal rows share one uniform triad (resolveTarget stamps
						// them together), so MIN over the group returns that single value.
						resolverId: sql<string>`MIN(${schema.contentReport.resolverId})`,
						resolution: sql<Resolution.Resolution>`MIN(${schema.contentReport.resolution})`,
					})
					.from(schema.contentReport)
					.where(inArray(schema.contentReport.status, ["resolved", "dismissed"]))
					.groupBy(schema.contentReport.targetKind, schema.contentReport.targetId)
					.orderBy(sql`MAX(${schema.contentReport.resolvedAt}) DESC`)
					.limit(limit),
			);
			return rows.map(
				(r) =>
					({
						targetKind: r.targetKind as TargetKind,
						targetId: r.targetId,
						resolution: r.resolution as Resolution.Resolution,
						resolverId: r.resolverId,
						// D1 stores `resolved_at` as integer seconds (timestamp mode); MAX
						// returns that raw value, so reconstruct the Date from seconds.
						resolvedAt: new Date(Number(r.resolvedAt) * 1000),
						reportCount: Number(r.reportCount),
					}) satisfies ResolvedReportGroup,
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
						// A wave gesture stamps ONE shared id across its targets (#1855); a
						// single-target resolve leaves it null. Always set explicitly so a
						// re-resolve never inherits a stale wave grouping.
						waveId: input.waveId ?? null,
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
					// Clearing `waveId` too keeps the invariant: an OPEN report never carries
					// a stale wave grouping (#1855).
					.set({
						status: "open",
						resolverId: null,
						resolvedAt: null,
						resolution: null,
						waveId: null,
					})
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

		const reopenForWave = Effect.fn("Report.reopenForWave")(function* (waveId: string) {
			const result = yield* run((db) =>
				db
					.update(schema.contentReport)
					.set({
						status: "open",
						resolverId: null,
						resolvedAt: null,
						resolution: null,
						waveId: null,
					})
					.where(
						and(
							eq(schema.contentReport.waveId, waveId),
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

		// Per-author moderator-removal count across the three content record tables
		// (`removed_by IS NOT NULL`). One grouped read per kind over the page's authors,
		// summed into a single author→count map. Empty input short-circuits with no read.
		const countRemovalsByAuthors = Effect.fn("Report.countRemovalsByAuthors")(function* (
			authorIds: ReadonlyArray<string>,
		) {
			const counts = new Map<string, number>();
			if (authorIds.length === 0) return counts;
			const ids = [...authorIds];
			const tables = [schema.postRecord, schema.commentRecord, schema.definitionRecord] as const;
			for (const table of tables) {
				const rows = yield* run((db) =>
					db
						.select({authorId: table.authorId, n: sql<number>`COUNT(*)`})
						.from(table)
						.where(and(inArray(table.authorId, ids), isNotNull(table.removedBy)))
						.groupBy(table.authorId),
				);
				for (const r of rows) counts.set(r.authorId, (counts.get(r.authorId) ?? 0) + Number(r.n));
			}
			return counts;
		});

		// Per-target open-report total + distinct-reporter count, keyed `<kind>:<id>`.
		// The composite report PK makes `COUNT(*)` and `COUNT(DISTINCT reporter_id)`
		// equal for content targets, but both are read so the shape is honest for the
		// #1855 wave slice. One grouped read over the page's targets.
		const reporterDiversity = Effect.fn("Report.reporterDiversity")(function* (
			targets: ReadonlyArray<{targetKind: TargetKind; targetId: string}>,
		) {
			const diversity = new Map<string, {reportCount: number; distinctReporters: number}>();
			if (targets.length === 0) return diversity;
			const targetIds = [...new Set(targets.map((t) => t.targetId))];
			const rows = yield* run((db) =>
				db
					.select({
						targetKind: schema.contentReport.targetKind,
						targetId: schema.contentReport.targetId,
						reportCount: sql<number>`COUNT(*)`,
						distinctReporters: sql<number>`COUNT(DISTINCT ${schema.contentReport.reporterId})`,
					})
					.from(schema.contentReport)
					.where(
						and(
							eq(schema.contentReport.status, "open"),
							inArray(schema.contentReport.targetId, targetIds),
						),
					)
					.groupBy(schema.contentReport.targetKind, schema.contentReport.targetId),
			);
			for (const r of rows) {
				diversity.set(`${r.targetKind}:${r.targetId}`, {
					reportCount: Number(r.reportCount),
					distinctReporters: Number(r.distinctReporters),
				});
			}
			return diversity;
		});

		// Per-author live production counts across the three record tables
		// (`removed_at IS NULL`). One grouped read per kind; each table maps to its
		// `ProductionCounts` field. Empty input short-circuits with no read.
		const productionCountsByAuthors = Effect.fn("Report.productionCountsByAuthors")(function* (
			authorIds: ReadonlyArray<string>,
		) {
			const counts = new Map<string, ProductionCounts>();
			if (authorIds.length === 0) return counts;
			const ids = [...authorIds];
			const kinds = [
				[schema.definitionRecord, "definitionCount"],
				[schema.postRecord, "postCount"],
				[schema.commentRecord, "commentCount"],
			] as const;
			for (const [table, field] of kinds) {
				const rows = yield* run((db) =>
					db
						.select({authorId: table.authorId, n: sql<number>`COUNT(*)`})
						.from(table)
						.where(and(inArray(table.authorId, ids), isNull(table.removedAt)))
						.groupBy(table.authorId),
				);
				for (const r of rows) {
					const cur = counts.get(r.authorId) ?? {
						definitionCount: 0,
						postCount: 0,
						commentCount: 0,
					};
					counts.set(r.authorId, {...cur, [field]: Number(r.n)});
				}
			}
			return counts;
		});

		// The "bu aktör" count (#1852): per author, how many DISTINCT of their targets
		// carry an open report. Joins `content_report` (open) to each record table by
		// target id per kind, groups by author. One read per kind over the page's
		// authors; a target's kind decides which record table carries its author.
		const countOpenReportedTargetsByAuthors = Effect.fn("Report.countOpenReportedTargetsByAuthors")(
			function* (authorIds: ReadonlyArray<string>) {
				const counts = new Map<string, number>();
				if (authorIds.length === 0) return counts;
				const ids = [...authorIds];
				const kinds = [
					["definition", schema.definitionRecord],
					["post", schema.postRecord],
					["comment", schema.commentRecord],
				] as const;
				for (const [kind, table] of kinds) {
					const rows = yield* run((db) =>
						db
							.select({
								authorId: table.authorId,
								n: sql<number>`COUNT(DISTINCT ${schema.contentReport.targetId})`,
							})
							.from(schema.contentReport)
							.innerJoin(table, eq(schema.contentReport.targetId, table.id))
							.where(
								and(
									eq(schema.contentReport.status, "open"),
									eq(schema.contentReport.targetKind, kind),
									inArray(table.authorId, ids),
								),
							)
							.groupBy(table.authorId),
					);
					for (const r of rows) {
						counts.set(r.authorId, (counts.get(r.authorId) ?? 0) + Number(r.n));
					}
				}
				return counts;
			},
		);

		return {
			readByReporter,
			listOpen,
			listResolved,
			resolveTarget,
			reopenForTarget,
			reopenForWave,
			lookupReportTarget,
			firstOpenReportId,
			countRemovalsByAuthors,
			reporterDiversity,
			productionCountsByAuthors,
			countOpenReportedTargetsByAuthors,
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
