/**
 * Reaction — the karma-free, ungated vote-engine twin. One canonical write
 * surface (`Reaction.react`) for the three reaction targets (`definition` |
 * `post` | `comment`), the third instance of the polymorphic per-user-presence
 * pattern (after `user_vote` / `post_bookmark`). Modeled on the pure-presence
 * {@link ../pano/Bookmark.ts Bookmark} shape rather than {@link ../vote/Vote.ts
 * Vote}: no score, no hot-score recompute, and — deliberately — no karma.
 *
 * UNGATED, deliberately (the settled divergence from Vote, #1861): a reaction is
 * a pure social signal that carries no karma, so ANY authenticated user —
 * including a çaylak newcomer — may react. There is NO `VoterStanding`/tier gate
 * (the #1810 "earn to vote" floor is Vote's alone) and NO `KarmaBump`
 * collaborator: the karma-bearing vote stays the sole karma lever, untouched.
 * A future reader must NOT "fix" this by wiring the tier gate — the ungatedness
 * is the point.
 *
 * Unlike bookmark (pure presence, no value), a reaction carries a value: the
 * chosen `emoji`, constrained to the curated `REACTION_EMOJI` palette. The
 * composite PK `(user_id, target_kind, target_id)` on `user_reaction` is the
 * cardinality-one constraint — at most one reaction per user per item — so
 * CHANGING a reaction is an upsert on the `emoji` column (`onConflictDoUpdate`).
 * `react` mirrors `Vote.cast`/`Bookmark.toggle` probe-then-write idempotency and
 * the `changed`-returning result: a new emoji replaces the prior one; re-reacting
 * the SAME emoji is a no-op (`changed: false`); a `null` emoji retracts (removes
 * the row).
 *
 * The `definition | post | comment` fan-out for the target-liveness check
 * dispatches through the shared `targetTable` descriptor seam
 * ({@link ../../db/target-table.ts}) — no re-stated per-kind switch. The
 * `user_reaction` cross-product table itself is Reaction-owned (the `user_vote`
 * twin Vote owns), so its reads/writes address `schema.userReaction` directly.
 */
import {and, eq, inArray} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, type DrizzleDb, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import type {ReactionEmoji} from "../../db/reaction-emoji.ts";
import type {TargetKind} from "../../db/target-kind.ts";
import {targetTable} from "../../db/target-table.ts";
import {ReactionTargetNotFound} from "./errors.ts";

// Re-exported from `db/target-kind.ts` (its source-of-truth home) for callers
// that prefer importing it from `./Reaction`.
export type {TargetKind};

export interface ReactInput {
	userId: string;
	targetKind: TargetKind;
	targetId: string;
	/**
	 * The reaction intent, a curated-palette member or a retract. A palette emoji
	 * sets/changes the user's single reaction; `null` retracts it (toggle off).
	 * The type only admits a `ReactionEmoji`, so a non-palette string is already
	 * rejected upstream by `ReactionEmojiSchema` at the wire boundary — the
	 * service never sees one.
	 */
	emoji: ReactionEmoji | null;
}

export interface ReactResult {
	targetKind: TargetKind;
	targetId: string;
	/** The viewer's reaction after the write — the chosen palette emoji, or `null` if none/retracted. */
	myReaction: ReactionEmoji | null;
	/** `false` on an idempotent no-op (state already matched intent). */
	changed: boolean;
}

export class Reaction extends Context.Service<
	Reaction,
	{
		/**
		 * Upsert the user's single reaction on a target (cardinality one-per-(user,
		 * target)). A palette `emoji` sets or REPLACES the prior reaction; passing
		 * the same emoji already held is an idempotent no-op (`changed: false`); a
		 * `null` emoji RETRACTS (removes the row). Rejects a missing/removed target
		 * with {@link ReactionTargetNotFound}. UNGATED and karma-free: no tier gate,
		 * no karma write — anyone logged in may react.
		 */
		readonly react: (input: ReactInput) => Effect.Effect<ReactResult, ReactionTargetNotFound>;
		/**
		 * Batched presence read: for each of `targetIds` the viewer has a reaction
		 * on, its current emoji — returned as a `Map<targetId, ReactionEmoji>` so
		 * hydration stamps the viewer's reaction without an N+1 (the
		 * `Vote.readMine` / `Bookmark.readMine` twin, extended to carry the emoji
		 * value). Missing viewer or empty `targetIds` short-circuits to an empty Map
		 * with no read.
		 */
		readonly readMine: (
			viewerId: string | null | undefined,
			kind: TargetKind,
			targetIds: ReadonlyArray<string>,
		) => Effect.Effect<Map<string, ReactionEmoji>>;
		/**
		 * The single reaction-cleanup home for the removal substrate (ADR 0096 §3,
		 * the `Vote.clearTarget` twin): wipe the `user_reaction` rows for one target
		 * in one D1 batch (ADR 0014). No score/karma cache to touch — reactions have
		 * none — so a removed entity never carries orphan reaction rows.
		 */
		readonly clearTarget: (kind: TargetKind, targetId: string) => Effect.Effect<void>;
	}
>()("@kampus/reaction/Reaction") {}

export const ReactionLive = Layer.effect(Reaction)(
	Effect.gen(function* () {
		// `orDieAccess`: DB failures are defects (domain-boundary rule), so the
		// public signature carries `ReactionTargetNotFound` only and `R` stays `never`.
		const {run, batch} = orDieAccess(yield* Drizzle);

		// Target-liveness lookup through the shared descriptor seam — the same
		// `definition | post | comment` fan-out Vote/Report dispatch through, so
		// the per-kind switch lives once in `db/target-table.ts`, not here. We only
		// need existence (a removed/missing target is `null`); the descriptor's
		// karma/sandbox fields are Vote's concern and go unread — reactions are
		// ungated, so a sandboxed target is reactable like any other live row.
		const assertTargetLive = Effect.fn("Reaction.assertTargetLive")(function* (
			kind: TargetKind,
			targetId: string,
		) {
			const meta = yield* run((db) => targetTable[kind].loadMeta(db, targetId));
			if (!meta) {
				return yield* new ReactionTargetNotFound({
					targetKind: kind,
					targetId,
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

		return {
			readMine,
			react: Effect.fn("Reaction.react")(function* (input: ReactInput) {
				yield* assertTargetLive(input.targetKind, input.targetId);

				const existing = yield* probeExisting(input.targetKind, input.targetId, input.userId);

				// State already matches intent → no write. Covers both the
				// re-react-same-emoji no-op (existing === emoji) and the
				// retract-when-none no-op (both null).
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
								// Upsert on the composite PK: a first react inserts, a change
								// overwrites the `emoji` in place — exactly one row per
								// (user, target) always holds (cardinality one).
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

/**
 * The one statement clearing a target's reactions: the `user_reaction` rows for
 * that (kind, target). Wrapped as a batch tuple for the same all-or-nothing
 * shape as `Vote.clearTarget` (ADR 0014); there is no score/karma cache to
 * co-mutate, so it is a single-statement batch.
 */
function buildClearTargetStatements(db: DrizzleDb, kind: TargetKind, targetId: string) {
	return [
		db
			.delete(schema.userReaction)
			.where(
				and(eq(schema.userReaction.targetKind, kind), eq(schema.userReaction.targetId, targetId)),
			),
	] as const;
}
