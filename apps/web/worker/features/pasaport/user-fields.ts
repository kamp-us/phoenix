/**
 * `User`'s one column→field map — the single structure the row mapper
 * (`toUserRow`, used by `Pasaport.getUserById`/`getUsersByIds`), the wire shaper
 * (`toUser` in `shapers.ts`), and the view field declaration (`UserView` in
 * `views.ts`) all derive from, so a one-field change touches this map instead of
 * three hand-synced restatements (#1545, the pasaport half of fate-wire epic
 * #1332). Mirrors `sozluk/definition-fields.ts`.
 *
 * `tier` and `isModerator` are the trusted-read fields stamped by the resolver,
 * not read from the `user` record here: `tier` is widened from the stored
 * `StoredTier` (`çaylak | yazar`) to the read-time `Tier` (`visitor` for a
 * row-missing principal) via `Kunye.tierOf`, and `isModerator` (#1320) is joined
 * off the `moderates` relation tuple (`trusted-user.ts`). So they ride on
 * `UserFields` (the view/shaper row) but are absent from `UserRow` (the
 * record-derived row).
 */
import type * as schema from "../../db/drizzle/schema.ts";
import type {Tier} from "../kunye/standing.ts";

type UserRecord = typeof schema.user.$inferSelect;

/**
 * The intrinsic (record-derived) wire fields, each mapping a `user` row onto its
 * wire value. The keys ARE the wire field names; the readers absorb the
 * nullable-column fallback. `tier` rides as the stored `StoredTier` here — the
 * resolver widens it to `Tier`.
 */
const intrinsicFields = {
	id: (u) => u.id,
	email: (u) => u.email,
	name: (u) => u.name ?? null,
	image: (u) => u.image ?? null,
	username: (u) => u.username ?? null,
	tier: (u) => u.tier,
} satisfies Record<string, (u: UserRecord) => unknown>;

/** `UserRow` — the record-derived row the user reads share (`tier` still stored). */
export type UserRow = {
	[K in keyof typeof intrinsicFields]: ReturnType<(typeof intrinsicFields)[K]>;
};

/**
 * `UserFields` — the wire shaper's input (`toUser`) and the `UserView` wire row:
 * the record-derived fields with `tier` widened to the read-time `Tier` and the
 * `isModerator` relation-tuple signal stamped by the resolver (`trusted-user.ts`),
 * never read from the record. Derived from `UserRow` so the field set can't drift.
 */
export interface UserFields extends Omit<UserRow, "tier"> {
	tier: Tier;
	isModerator: boolean;
}

/**
 * The view/wire field selection (`{id: true, …}`) — a static literal (fate's
 * `FateDataView` reads the literal field map off this). `satisfies Record<keyof
 * UserFields, true>` pins it to exactly the wire row's fields: dropping one here
 * (or adding one to `UserFields` without listing it) is a compile error, so the
 * view stays in lockstep with the shaper.
 */
export const userViewFields = {
	id: true,
	email: true,
	name: true,
	image: true,
	username: true,
	tier: true,
	isModerator: true,
} as const satisfies Record<keyof UserFields, true>;

/**
 * Map a `user` record onto its `UserRow` fields by running every reader in the
 * column→field map — the single place the record→row mapping lives. `tier`
 * widening + `isModerator` are stamped by the resolver (`trusted-user.ts`), not
 * here.
 */
export const toUserRow = (u: UserRecord): UserRow =>
	Object.fromEntries(
		(Object.keys(intrinsicFields) as Array<keyof typeof intrinsicFields>).map((f) => [
			f,
			intrinsicFields[f](u),
		]),
	) as UserRow;
