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
import {and, eq, inArray} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {type ReportTargetKind, ReportTargetNotFound} from "./errors.ts";

// Re-exported from `errors.ts` (its source-of-truth home) for callers that
// prefer importing it from `./Report`.
export type {ReportTargetKind};

export interface ReportInput {
	reporterId: string;
	targetKind: ReportTargetKind;
	targetId: string;
	/** Optional free-text reason. */
	reason?: string | null;
}

export interface ReportResult {
	targetKind: ReportTargetKind;
	targetId: string;
	/** `false` on idempotent no-op (the reporter already reported this target). */
	created: boolean;
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
			kind: ReportTargetKind,
			targetIds: ReadonlyArray<string>,
		) => Effect.Effect<Set<string>>;
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
			kind: ReportTargetKind,
			targetId: string,
		) {
			const exists = yield* run((db) => {
				switch (kind) {
					case "definition":
						return db.query.definitionView.findFirst({
							where: {id: targetId, deletedAt: {isNull: true}},
							columns: {id: true},
						});
					case "post":
						return db.query.postSummary.findFirst({
							where: {id: targetId, deletedAt: {isNull: true}},
							columns: {id: true},
						});
					case "comment":
						return db.query.commentView.findFirst({
							where: {id: targetId, deletedAt: {isNull: true}},
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
			kind: ReportTargetKind,
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

		return {
			readByReporter,
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
