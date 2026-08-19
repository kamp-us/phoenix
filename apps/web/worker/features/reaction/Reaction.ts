/**
 * Reaction — the karma-free, ungated vote-engine twin: one write surface
 * (`Reaction.react`) over the three targets (`definition` | `post` | `comment`),
 * with the composite PK `(user_id, target_kind, target_id)` as the one-per-user
 * cardinality constraint, so a change is an upsert on `emoji`.
 *
 * Ungated and karma-free deliberately (ADR 0139): no `VoterStanding` tier gate and
 * no `KarmaBump` — a future reader must NOT "fix" this by wiring the vote's gate in.
 */
import {and, eq, inArray, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import type {Concurrency} from "effect/Types";
import {Drizzle, type DrizzleDb, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {REACTION_EMOJI, type ReactionEmoji} from "../../db/reaction-emoji.ts";
import type {TargetKind} from "../../db/target-kind.ts";
import {targetTable} from "../../db/target-table.ts";
import {TargetId} from "../../lib/ids.ts";
import {Telemetry} from "../telemetry/Telemetry.ts";
import {ReactionTargetNotFound} from "./errors.ts";

export type {TargetKind};

export interface ReactInput {
	userId: string;
	targetKind: TargetKind;
	targetId: string;
	/** A palette emoji sets or replaces the reaction; `null` retracts it. */
	emoji: ReactionEmoji | null;
}

export interface ReactResult {
	targetKind: TargetKind;
	targetId: string;
	myReaction: ReactionEmoji | null;
	/** `false` on an idempotent no-op (state already matched intent). */
	changed: boolean;
}

export interface ReactionCount {
	emoji: ReactionEmoji;
	count: number;
}

/**
 * A target's reaction aggregate. `counts` holds only palette members with a non-zero
 * tally, ordered by the curated `REACTION_EMOJI` palette so every reader sees the bar
 * in one canonical order; `myReaction` is `null` for an anonymous or non-reacting viewer.
 */
export interface ReactionAggregate {
	counts: ReadonlyArray<ReactionCount>;
	myReaction: ReactionEmoji | null;
}

export const EMPTY_REACTION_AGGREGATE: ReactionAggregate = {counts: [], myReaction: null};

// Palette member → its position, so a batched aggregate can be sorted into the one
// canonical `REACTION_EMOJI` order regardless of GROUP BY row order.
const PALETTE_ORDER = new Map<string, number>(REACTION_EMOJI.map((emoji, i) => [emoji, i]));

export class Reaction extends Context.Service<
	Reaction,
	{
		/**
		 * A palette `emoji` sets or REPLACES the prior reaction; the same emoji already
		 * held is an idempotent no-op (`changed: false`); `null` RETRACTS. Rejects a
		 * missing/removed target with {@link ReactionTargetNotFound}.
		 */
		readonly react: (input: ReactInput) => Effect.Effect<ReactResult, ReactionTargetNotFound>;
		/**
		 * Batched presence read: the viewer's current emoji per target, so hydration stamps
		 * a page without an N+1. Missing viewer or empty `targetIds` reads nothing.
		 */
		readonly readMine: (
			viewerId: string | null | undefined,
			kind: TargetKind,
			targetIds: ReadonlyArray<string>,
		) => Effect.Effect<Map<string, ReactionEmoji>>;
		/**
		 * Batched aggregate read: one `GROUP BY` tally plus the viewer's `readMine` for a whole
		 * page. A target with no reactions is ABSENT from the map (the caller fills the empty
		 * aggregate). The two reads are independent; `options.concurrency` opts them into
		 * concurrent execution — absent ⇒ sequential.
		 */
		readonly readAggregate: (
			viewerId: string | null | undefined,
			kind: TargetKind,
			targetIds: ReadonlyArray<string>,
			options?: {readonly concurrency?: Concurrency},
		) => Effect.Effect<Map<string, ReactionAggregate>>;
		/** Wipes one target's `user_reaction` rows for the removal substrate (ADR 0096 §3). */
		readonly clearTarget: (kind: TargetKind, targetId: string) => Effect.Effect<void>;
	}
>()("@kampus/reaction/Reaction") {}

export const ReactionLive = Layer.effect(Reaction)(
	Effect.gen(function* () {
		const {run, batch} = orDieAccess(yield* Drizzle);

		// Resolved once at layer build so `react` gains no per-request wiring. `emit` is
		// fire-and-forget: its failure is swallowed in `TelemetryLive` (ADR 0153 fail-safe).
		const telemetry = yield* Telemetry;

		// Existence only — the descriptor's karma/sandbox fields are Vote's concern and go
		// unread, since a sandboxed target is reactable like any other live row.
		const assertTargetLive = Effect.fn("Reaction.assertTargetLive")(function* (
			kind: TargetKind,
			targetId: string,
		) {
			const meta = yield* run((db) => targetTable[kind].loadMeta(db, targetId));
			if (!meta) {
				return yield* new ReactionTargetNotFound({
					targetKind: kind,
					targetId: TargetId.make(targetId),
					message: `reaction target ${kind} ${targetId} not found`,
				});
			}
		});

		// Idempotency probe: the viewer's current emoji on the target, or `null`.
		const probeExisting = (kind: TargetKind, targetId: string, userId: string) =>
			run((db) =>
				db.query.userReaction
					.findFirst({
						where: {userId, targetKind: kind, targetId},
						columns: {emoji: true},
					})
					.then((row) => row?.emoji ?? null),
			);

		const readMine = Effect.fn("Reaction.readMine")(function* (
			viewerId: string | null | undefined,
			kind: TargetKind,
			targetIds: ReadonlyArray<string>,
		) {
			if (!viewerId || targetIds.length === 0) return new Map<string, ReactionEmoji>();
			const rows = yield* run((db) =>
				db
					.select({
						targetId: schema.userReaction.targetId,
						emoji: schema.userReaction.emoji,
					})
					.from(schema.userReaction)
					.where(
						and(
							eq(schema.userReaction.userId, viewerId),
							eq(schema.userReaction.targetKind, kind),
							inArray(schema.userReaction.targetId, [...targetIds]),
						),
					),
			);
			return new Map(rows.map((r) => [r.targetId, r.emoji]));
		});

		const readAggregate = Effect.fn("Reaction.readAggregate")(function* (
			viewerId: string | null | undefined,
			kind: TargetKind,
			targetIds: ReadonlyArray<string>,
			options?: {readonly concurrency?: Concurrency},
		) {
			const out = new Map<string, ReactionAggregate>();
			if (targetIds.length === 0) return out;

			// One GROUP BY over the whole page, served by the `user_reaction_target` index.
			// `Effect.all` defaults to `concurrency: 1`, so passing one is what collapses the two
			// reads into a single wave phase.
			const [rows, mine] = yield* Effect.all(
				[
					run((db) =>
						db
							.select({
								targetId: schema.userReaction.targetId,
								emoji: schema.userReaction.emoji,
								count: sql<number>`count(*)`,
							})
							.from(schema.userReaction)
							.where(
								and(
									eq(schema.userReaction.targetKind, kind),
									inArray(schema.userReaction.targetId, [...targetIds]),
								),
							)
							.groupBy(schema.userReaction.targetId, schema.userReaction.emoji),
					),
					readMine(viewerId, kind, targetIds),
				],
				{concurrency: options?.concurrency ?? 1},
			);

			const byTarget = new Map<string, ReactionCount[]>();
			for (const row of rows) {
				const list = byTarget.get(row.targetId) ?? [];
				list.push({emoji: row.emoji, count: row.count});
				byTarget.set(row.targetId, list);
			}

			// A target appears iff it has reactions OR the viewer reacted on it.
			const targets = new Set<string>([...byTarget.keys(), ...mine.keys()]);
			for (const targetId of targets) {
				const counts = (byTarget.get(targetId) ?? []).sort(
					(a, b) => (PALETTE_ORDER.get(a.emoji) ?? 0) - (PALETTE_ORDER.get(b.emoji) ?? 0),
				);
				out.set(targetId, {counts, myReaction: mine.get(targetId) ?? null});
			}
			return out;
		});

		return {
			readMine,
			readAggregate,
			react: Effect.fn("Reaction.react")(function* (input: ReactInput) {
				yield* assertTargetLive(input.targetKind, input.targetId);

				const existing = yield* probeExisting(input.targetKind, input.targetId, input.userId);

				// Covers both the re-react-same-emoji and the retract-when-none no-op.
				if (existing === input.emoji) {
					return {
						targetKind: input.targetKind,
						targetId: input.targetId,
						myReaction: existing,
						changed: false,
					} satisfies ReactResult;
				}

				const now = new Date();
				yield* batch((db) =>
					input.emoji === null
						? ([
								db
									.delete(schema.userReaction)
									.where(
										and(
											eq(schema.userReaction.userId, input.userId),
											eq(schema.userReaction.targetKind, input.targetKind),
											eq(schema.userReaction.targetId, input.targetId),
										),
									),
							] as const)
						: ([
								// Upsert on the composite PK: a first react inserts, a change overwrites
								// `emoji` in place, so exactly one row per (user, target) always holds.
								db
									.insert(schema.userReaction)
									.values({
										userId: input.userId,
										targetKind: input.targetKind,
										targetId: input.targetId,
										emoji: input.emoji,
										createdAt: now,
									})
									.onConflictDoUpdate({
										target: [
											schema.userReaction.userId,
											schema.userReaction.targetKind,
											schema.userReaction.targetId,
										],
										set: {emoji: input.emoji},
									}),
							] as const),
				);

				// After the write commits and only on a real change — the `changed: false` return
				// above means a no-op emits nothing (ADR 0153).
				yield* telemetry.emit({
					feature: "reaction",
					action: input.emoji === null ? "retract" : "react",
					surface: input.targetKind,
					userId: input.userId,
					...(input.emoji === null ? {} : {emoji: input.emoji}),
				});

				return {
					targetKind: input.targetKind,
					targetId: input.targetId,
					myReaction: input.emoji,
					changed: true,
				} satisfies ReactResult;
			}),
			clearTarget: Effect.fn("Reaction.clearTarget")(function* (
				kind: TargetKind,
				targetId: string,
			) {
				yield* batch((db) => buildClearTargetStatements(db, kind, targetId));
			}),
		};
	}),
);

/** One statement, wrapped as a batch tuple for the `Vote.clearTarget` shape (ADR 0014). */
function buildClearTargetStatements(db: DrizzleDb, kind: TargetKind, targetId: string) {
	return [
		db
			.delete(schema.userReaction)
			.where(
				and(eq(schema.userReaction.targetKind, kind), eq(schema.userReaction.targetId, targetId)),
			),
	] as const;
}
