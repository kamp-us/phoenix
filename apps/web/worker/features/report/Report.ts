/**
 * Report — the polymorphic content-report service over the three targets
 * (`definition` / `post` / `comment`). Idempotency lives in the table:
 * `content_report`'s composite PK `(reporter_id, target_kind, target_id)` +
 * `onConflictDoNothing` makes a re-report by the same user a no-op success. No
 * live view publishes off a write — a report is private moderation state.
 */
import {and, eq, inArray, isNotNull, isNull, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {type TargetKind, targetKey} from "../../db/target-kind.ts";
import {targetTable} from "../../db/target-table.ts";
import {TargetId} from "../../lib/ids.ts";
import {ReportTargetNotFound} from "./errors.ts";
import * as Resolution from "./resolution.ts";

export type {TargetKind};

export interface ReportInput {
	reporterId: string;
	targetKind: TargetKind;
	targetId: string;
	reason?: string | null;
}

export interface ReportResult {
	targetKind: TargetKind;
	targetId: string;
	/** `false` on idempotent no-op (the reporter already reported this target). */
	created: boolean;
}

/** One row of the moderation queue — open reports grouped by target. See ADR 0098 §5. */
export interface OpenReportGroup {
	targetKind: TargetKind;
	targetId: string;
	/** Distinct reporters who have an OPEN report on this target. */
	reportCount: number;
	/** The earliest open report's reason (representative free-text), or null. */
	reason: string | null;
	firstReportedAt: Date;
}

/**
 * One row of the shared decision feed: a resolved/dismissed target with the audit
 * triad. A target's terminal rows share one uniform triad (`resolveTarget` stamps
 * them together), so the group carries a single resolver/resolution/waveId.
 */
export interface ResolvedReportGroup {
	targetKind: TargetKind;
	targetId: string;
	resolution: Resolution.Resolution;
	resolverId: string;
	resolvedAt: Date;
	reportCount: number;
	/** Shared across a wave's targets, `null` on a lone removal — the restore-as-a-unit key (ADR 0138). */
	waveId: string | null;
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
	/** The shared wave-grouping id when this resolve is one target of a wave gesture (ADR 0138). */
	waveId?: string | null;
}

export interface ResolveTargetResult {
	/** How many open reports on this target were collapsed in the batch. */
	collapsed: number;
	/**
	 * Whether THIS resolve owned the `open → terminal` transition — true iff it
	 * flipped at least one open row (`collapsed > 0`). The terminal stamp is the one
	 * point that arbitrates the transition, so the resolve mutation keys its removal
	 * leg on this: a moderator whose concurrent resolve stamped the report terminal
	 * first leaves `wonTransition` false here, and the removal is skipped — content is
	 * never removed under another moderator's (e.g. dismissed) verdict (#2555).
	 */
	wonTransition: boolean;
}

export class Report extends Context.Service<
	Report,
	{
		readonly submit: (input: ReportInput) => Effect.Effect<ReportResult, ReportTargetNotFound>;
		/** Which of `targetIds` the viewer already reported, in one batched read (no N+1). */
		readonly readByReporter: (
			viewerId: string | null | undefined,
			kind: TargetKind,
			targetIds: ReadonlyArray<string>,
		) => Effect.Effect<Set<string>>;

		/** Moderation queue: open reports grouped by target, oldest-first. Gated behind `Moderate` in the resolver (ADR 0098 §5, ADR 0107 §4). */
		readonly listOpen: (opts?: {limit?: number}) => Effect.Effect<ReadonlyArray<OpenReportGroup>>;

		/** Decision feed: resolved/dismissed targets, newest-first. Bounded single page, no cursor. */
		readonly listResolved: (opts?: {
			limit?: number;
		}) => Effect.Effect<ReadonlyArray<ResolvedReportGroup>>;

		/**
		 * Collapse EVERY open report on the target to its terminal status in one batch,
		 * stamping the audit triad. Idempotent. The authority check lives in the
		 * resolver, not here. See ADR 0098 §3/§4.
		 */
		readonly resolveTarget: (input: ResolveTargetInput) => Effect.Effect<ResolveTargetResult>;

		/** Flip every terminal report on the target back to `open`, clearing its audit triad (ADR 0098 §3, ADR 0096 §4). */
		readonly reopenForTarget: (input: {
			targetKind: TargetKind;
			targetId: string;
		}) => Effect.Effect<{reopened: number}>;

		/** Reopen every terminal report sharing `waveId` as a unit, clearing the grouping (ADR 0138). */
		readonly reopenForWave: (waveId: string) => Effect.Effect<{reopened: number}>;

		/** The distinct still-terminal targets sharing `waveId`; empty once the wave has been reopened (ADR 0138). */
		readonly waveTargets: (
			waveId: string,
		) => Effect.Effect<ReadonlyArray<{targetKind: TargetKind; targetId: string}>>;

		/** The `(targetKind, targetId)` behind a report id, so a resolve keyed on one report acts on its whole target group (ADR 0098). */
		readonly lookupReportTarget: (
			reportId: string,
		) => Effect.Effect<{targetKind: TargetKind; targetId: string} | null>;

		/** The earliest OPEN report id — the one a `Moderated({reportId})` removal links to, so a later restore reopens the whole group. */
		readonly firstOpenReportId: (
			targetKind: TargetKind,
			targetId: string,
		) => Effect.Effect<string | null>;

		/** Per author, how many of their targets a moderator previously removed. Absent authors carry 0 (ADR 0138). */
		readonly countRemovalsByAuthors: (
			authorIds: ReadonlyArray<string>,
		) => Effect.Effect<ReadonlyMap<string, number>>;

		/**
		 * Per target, open reports + DISTINCT reporters, keyed `<kind>:<id>`. The composite
		 * report PK makes the two equal today; both are read so the shape is honest for the
		 * wave-vs-grudge-reporter slice (ADR 0138).
		 */
		readonly reporterDiversity: (
			targets: ReadonlyArray<{targetKind: TargetKind; targetId: string}>,
		) => Effect.Effect<ReadonlyMap<string, {reportCount: number; distinctReporters: number}>>;

		/** Per author, live (`removed_at IS NULL`) definition/post/comment counts; absent authors carry a zeroed triple. */
		readonly productionCountsByAuthors: (
			authorIds: ReadonlyArray<string>,
		) => Effect.Effect<ReadonlyMap<string, ProductionCounts>>;

		/** Per author, how many DISTINCT of their targets carry an open report. Absent authors carry 0. */
		readonly countOpenReportedTargetsByAuthors: (
			authorIds: ReadonlyArray<string>,
		) => Effect.Effect<ReadonlyMap<string, number>>;
	}
>()("@kampus/report/Report") {}

export interface ProductionCounts {
	definitionCount: number;
	postCount: number;
	commentCount: number;
}

export const ReportLive = Layer.effect(Report)(
	Effect.gen(function* () {
		// `orDieAccess`: infra failures are defects. See ADR 0013/0014, `.patterns/feature-services.md`.
		const {run} = orDieAccess(yield* Drizzle);

		const assertTargetLive = Effect.fn("Report.assertTargetLive")(function* (
			kind: TargetKind,
			targetId: string,
		) {
			const meta = yield* run((db) => targetTable[kind].loadMeta(db, targetId));
			if (!meta) {
				return yield* new ReportTargetNotFound({
					targetKind: kind,
					targetId: TargetId.make(targetId),
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
						// D1 timestamp mode stores integer seconds; MIN returns the raw value.
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
						// A target's terminal rows share one uniform triad + waveId, so MIN over
						// the group returns that single value.
						resolverId: sql<string>`MIN(${schema.contentReport.resolverId})`,
						resolution: sql<Resolution.Resolution>`MIN(${schema.contentReport.resolution})`,
						waveId: sql<string | null>`MIN(${schema.contentReport.waveId})`,
					})
					.from(schema.contentReport)
					.where(inArray(schema.contentReport.status, Resolution.TERMINAL_STATUSES))
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
						// D1 timestamp mode stores integer seconds; MAX returns the raw value.
						resolvedAt: new Date(Number(r.resolvedAt) * 1000),
						reportCount: Number(r.reportCount),
						waveId: r.waveId ?? null,
					}) satisfies ResolvedReportGroup,
			);
		});

		const resolveTarget = Effect.fn("Report.resolveTarget")(function* (input: ResolveTargetInput) {
			// The `"open"` source is hardcoded-legal, so the `Result` is always a success;
			// `orDie` discharges the impossible `IllegalTransition` — reachable only if this
			// literal is later changed to a non-open source (#2560).
			const {status, resolution} = yield* Effect.orDie(
				Effect.fromResult(Resolution.resolve("open", input.action)),
			);
			const result = yield* run((db) =>
				db
					.update(schema.contentReport)
					.set({
						status,
						resolverId: input.resolverId,
						resolvedAt: input.resolvedAt,
						resolution,
						// Always set explicitly so a re-resolve never inherits a stale wave grouping.
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
			const collapsed = result.meta.changes;
			return {collapsed, wonTransition: collapsed > 0} satisfies ResolveTargetResult;
		});

		const reopenForTarget = Effect.fn("Report.reopenForTarget")(function* (input: {
			targetKind: TargetKind;
			targetId: string;
		}) {
			// The hardcoded-terminal `"resolved"` source is always legal, so `orDie` discharges
			// the impossible `IllegalTransition` — reachable only if this literal is later
			// changed to a non-terminal source (#2560).
			const status = yield* Effect.orDie(Effect.fromResult(Resolution.reopen("resolved")));
			const result = yield* run((db) =>
				db
					.update(schema.contentReport)
					// Clearing `waveId` too holds the invariant: an OPEN report never carries a wave grouping.
					.set({
						status,
						resolverId: null,
						resolvedAt: null,
						resolution: null,
						waveId: null,
					})
					.where(
						and(
							eq(schema.contentReport.targetKind, input.targetKind),
							eq(schema.contentReport.targetId, input.targetId),
							inArray(schema.contentReport.status, Resolution.TERMINAL_STATUSES),
						),
					)
					.run(),
			);
			return {reopened: result.meta.changes};
		});

		const reopenForWave = Effect.fn("Report.reopenForWave")(function* (waveId: string) {
			// Hardcoded-legal source; `orDie` discharges the impossible `IllegalTransition`
			// (see `reopenForTarget`).
			const status = yield* Effect.orDie(Effect.fromResult(Resolution.reopen("resolved")));
			const result = yield* run((db) =>
				db
					.update(schema.contentReport)
					.set({
						status,
						resolverId: null,
						resolvedAt: null,
						resolution: null,
						waveId: null,
					})
					.where(
						and(
							eq(schema.contentReport.waveId, waveId),
							inArray(schema.contentReport.status, Resolution.TERMINAL_STATUSES),
						),
					)
					.run(),
			);
			return {reopened: result.meta.changes};
		});

		const waveTargets = Effect.fn("Report.waveTargets")(function* (waveId: string) {
			const rows = yield* run((db) =>
				db
					.selectDistinct({
						targetKind: schema.contentReport.targetKind,
						targetId: schema.contentReport.targetId,
					})
					.from(schema.contentReport)
					.where(
						and(
							eq(schema.contentReport.waveId, waveId),
							inArray(schema.contentReport.status, Resolution.TERMINAL_STATUSES),
						),
					),
			);
			return rows.map((r) => ({targetKind: r.targetKind as TargetKind, targetId: r.targetId}));
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
				diversity.set(targetKey(r.targetKind, r.targetId), {
					reportCount: Number(r.reportCount),
					distinctReporters: Number(r.distinctReporters),
				});
			}
			return diversity;
		});

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
			waveTargets,
			lookupReportTarget,
			firstOpenReportId,
			countRemovalsByAuthors,
			reporterDiversity,
			productionCountsByAuthors,
			countOpenReportedTargetsByAuthors,
			submit: Effect.fn("Report.submit")(function* (input: ReportInput) {
				yield* assertTargetLive(input.targetKind, input.targetId);

				// Idempotent on the composite PK; the fresh `id` on a conflicting insert never lands.
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
