/**
 * Mute ("sustur") — pure presence over a one-directional `(muter, muted)` relationship,
 * the `Bookmark` shape keyed on two users. No value column, no karma, no fanout. This is
 * the storage + domain seam only: no read-masking, no UI, and NOT *block* (mutual
 * interaction-ban) semantics.
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

/** The profile handle is joined at the fate seam; this service stays over its own table. */
export interface MutedMemberRow {
	mutedId: string;
	mutedAt: Date;
}

/** `first` is clamped 1..100 (default 20); `after` is an opaque cursor (a muted member id). */
export interface MutedMemberListOpts {
	first?: number | undefined;
	after?: string | null | undefined;
}

/**
 * Exported pure so the ownership predicate is `.toSQL()`-inspectable with no engine (the
 * `unreadCountQuery` idiom, ADR 0082): `muter_id` rides every read predicate, so "list
 * someone else's mutes" matches zero rows by construction.
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
	/** `true` mutes, `false` un-mutes. */
	value: boolean;
}

export interface MuteSetResult {
	mutedId: string;
	isMuted: boolean;
	/** `false` on an idempotent no-op (state already matched intent). */
	changed: boolean;
}

export class Mute extends Context.Service<
	Mute,
	{
		/** Idempotent (probe-then-write). Self-mute is rejected before any read. */
		readonly set: (input: MuteSetInput) => Effect.Effect<MuteSetResult, SelfMuteRejected>;
		/** ONE read over the PK's leading column, so read-masking stamps without an N+1. */
		readonly readMutedIds: (viewerId: string | null | undefined) => Effect.Effect<Set<string>>;
		/**
		 * The muter scope is structural: every read carries `muter_id`, so a foreign cursor
		 * is a miss rather than a probe into another muter's rows.
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
