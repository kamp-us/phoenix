/**
 * Mute — member-side mute ("sustur") service. Pure presence over a one-directional
 * `(muter, muted)` relationship, the {@link ../pano/Bookmark Bookmark} shape keyed
 * on two users instead of (user, post): a `user_mute` row means the muter has muted
 * the muted member, its absence means not. No value column, no karma, no fanout.
 *
 * `set` is idempotent (probe-then-write, like `Bookmark.toggle`): re-muting an
 * already-muted member — or un-muting an unmuted pair — is a no-op that writes
 * nothing and returns `changed: false`. Self-mute is rejected in the domain object:
 * a member cannot mute themselves (`SelfMuteRejected`, checked before any read).
 *
 * `readMutedIds` is the batched viewer-side read that downstream read-masking stamps
 * from without an N+1: one query over the composite PK's leading `muter_id` column
 * returns the whole set of ids the viewer has muted. A missing viewer short-circuits
 * to an empty set with no read.
 *
 * Scope: storage + domain seam only. No fate/mutation exposure, no read-masking, no
 * UI, no *block* (mutual interaction-ban) semantics — those are siblings.
 */
import {and, eq} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {UserId} from "../../lib/ids.ts";
import {SelfMuteRejected} from "./errors.ts";

export interface MuteSetInput {
	muterId: string;
	mutedId: string;
	/** Presence intent: `true` mutes, `false` un-mutes (mirrors `BookmarkToggleInput.value`). */
	value: boolean;
}

export interface MuteSetResult {
	mutedId: string;
	/** The muter's mute presence over `mutedId` after the write. */
	isMuted: boolean;
	/** `false` on an idempotent no-op (state already matched intent). */
	changed: boolean;
}

export class Mute extends Context.Service<
	Mute,
	{
		/**
		 * Set the muter's mute presence over `mutedId` to `value`, idempotently
		 * (probe-then-write). A matching state is a no-op (`changed: false`, no
		 * write). Self-mute (`muterId === mutedId`) is rejected before any read.
		 */
		readonly set: (input: MuteSetInput) => Effect.Effect<MuteSetResult, SelfMuteRejected>;
		/**
		 * The full set of member ids the viewer has muted, in one read over the
		 * `(muter_id, muted_id)` PK's leading column so read-masking stamps without
		 * an N+1. Missing viewer short-circuits to an empty Set with no read.
		 */
		readonly readMutedIds: (viewerId: string | null | undefined) => Effect.Effect<Set<string>>;
	}
>()("@kampus/mute/Mute") {}

export const MuteLive = Layer.effect(Mute)(
	Effect.gen(function* () {
		// `orDieAccess`: DB failures are defects (domain-boundary rule), so the
		// public signature carries `SelfMuteRejected` only and `R` stays `never`.
		const {run, batch} = orDieAccess(yield* Drizzle);

		const readMutedIds = Effect.fn("Mute.readMutedIds")(function* (
			viewerId: string | null | undefined,
		) {
			if (!viewerId) return new Set<string>();
			const rows = yield* run((db) =>
				db
					.select({mutedId: schema.userMute.mutedId})
					.from(schema.userMute)
					.where(eq(schema.userMute.muterId, viewerId)),
			);
			return new Set(rows.map((r) => r.mutedId));
		});

		return {
			readMutedIds,
			set: Effect.fn("Mute.set")(function* (input: MuteSetInput) {
				if (input.muterId === input.mutedId) {
					return yield* new SelfMuteRejected({
						memberId: UserId.make(input.muterId),
						message: "a member cannot mute themselves",
					});
				}

				const existing = yield* run((db) =>
					db.query.userMute.findFirst({
						where: {muterId: input.muterId, mutedId: input.mutedId},
						columns: {mutedId: true},
					}),
				);
				const alreadyMuted = existing != null;

				if (input.value === alreadyMuted) {
					return {
						mutedId: input.mutedId,
						isMuted: alreadyMuted,
						changed: false,
					} satisfies MuteSetResult;
				}

				yield* batch((db) =>
					input.value
						? ([
								db
									.insert(schema.userMute)
									.values({
										muterId: input.muterId,
										mutedId: input.mutedId,
										createdAt: new Date(),
									})
									.onConflictDoNothing(),
							] as const)
						: ([
								db
									.delete(schema.userMute)
									.where(
										and(
											eq(schema.userMute.muterId, input.muterId),
											eq(schema.userMute.mutedId, input.mutedId),
										),
									),
							] as const),
				);

				return {
					mutedId: input.mutedId,
					isMuted: input.value,
					changed: true,
				} satisfies MuteSetResult;
			}),
		};
	}),
);
