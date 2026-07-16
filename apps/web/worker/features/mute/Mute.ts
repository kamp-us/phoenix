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
import {and, desc, eq, type SQL} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, type DrizzleDb, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {
	emptyKeysetPage,
	forwardPage,
	type KeysetPage,
	keysetAfter,
	resolveCursor,
} from "../../db/keyset.ts";
import {UserId} from "../../lib/ids.ts";
import {SelfMuteRejected} from "./errors.ts";

/** One entry of the viewer's own muted-members list — the muted member id (the row
 * identity + keyset cursor) and when the mute was set (the newest-first order key).
 * Hydrated with the muted member's profile handle in the `mute.listMine` resolver
 * (the domain service stays over its own table; identity is joined at the fate seam). */
export interface MutedMemberRow {
	mutedId: string;
	mutedAt: Date;
}

/** Options for {@link Mute.listMine} — `first` page size (clamped 1..100, default 20),
 * `after` the opaque forward keyset cursor (a muted member id). */
export interface MutedMemberListOpts {
	first?: number | undefined;
	after?: string | null | undefined;
}

/**
 * The viewer's muted-members page read, scoped to `muter_id = muterId` and ordered
 * newest-mute-first (`created_at desc`, `muted_id desc` as the stable tiebreaker).
 * Exported pure so the ownership predicate is `.toSQL()`-inspectable with no engine
 * (the `unreadCountQuery` idiom, ADR 0082): `muter_id` rides every read predicate, so
 * "list someone else's mutes" matches zero rows by construction.
 */
export const mutedMembersQuery = (db: DrizzleDb, muterId: string, cursorPredicate?: SQL) =>
	db
		.select({mutedId: schema.userMute.mutedId, createdAt: schema.userMute.createdAt})
		.from(schema.userMute)
		.where(
			cursorPredicate
				? and(eq(schema.userMute.muterId, muterId), cursorPredicate)
				: eq(schema.userMute.muterId, muterId),
		)
		.orderBy(desc(schema.userMute.createdAt), desc(schema.userMute.mutedId));

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
		/**
		 * The viewer's own muted members, newest-mute-first, forward keyset-paginated
		 * over the `(muter_id, muted_id)` PK's leading column. A missing viewer short-
		 * circuits to the empty page with no read; a foreign/dead cursor is the shared
		 * cursor-miss empty page (never a probe into another muter's rows). The muter
		 * scope is structural — every read carries `muter_id`, so a member only ever
		 * pages their own mutes.
		 */
		readonly listMine: (
			viewerId: string | null | undefined,
			opts?: MutedMemberListOpts,
		) => Effect.Effect<KeysetPage<MutedMemberRow>>;
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

		const listMine = Effect.fn("Mute.listMine")(function* (
			viewerId: string | null | undefined,
			opts: MutedMemberListOpts = {},
		) {
			if (!viewerId) return emptyKeysetPage;
			const first = Math.max(1, Math.min(opts.first ?? 20, 100));
			const after = opts.after ?? null;

			// The DB read is the port; `resolveCursor` is the pure cursor-miss decision
			// (the bildirim idiom). The cursor is a muted member id, resolved to its
			// `created_at` for the keyset tuple — muter-scoped, so a foreign cursor is a
			// miss, not a probe into another muter's list.
			const resolvedRow = after
				? ((yield* run((db) =>
						db
							.select({createdAt: schema.userMute.createdAt})
							.from(schema.userMute)
							.where(and(eq(schema.userMute.muterId, viewerId), eq(schema.userMute.mutedId, after)))
							.get(),
					)) ?? null)
				: null;
			const cursor = resolveCursor(after, resolvedRow);
			if (cursor.kind === "miss") return emptyKeysetPage;
			const cursorRow = cursor.kind === "hit" ? cursor.row : null;

			const cursorPredicate = keysetAfter([
				{column: schema.userMute.createdAt, dir: "desc", value: cursorRow?.createdAt ?? null},
				{column: schema.userMute.mutedId, dir: "desc", value: after},
			]);

			const fetched = yield* run((db) =>
				mutedMembersQuery(db, viewerId, cursorPredicate).limit(first + 1),
			);
			return forwardPage<(typeof fetched)[number], MutedMemberRow>(
				fetched,
				first,
				(row) => row.mutedId,
				(row) => ({mutedId: row.mutedId, mutedAt: row.createdAt}),
			);
		});

		return {
			readMutedIds,
			listMine,
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
