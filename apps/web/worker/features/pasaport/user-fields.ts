/**
 * `User`'s one column→field map. The row mapper, the wire shaper and the view field
 * declaration all derive from it, so a one-field change lands here (#1545).
 *
 * `tier` and `isModerator` are stamped by the resolver, not read from the record:
 * `tier` widens the stored value to the read-time one (`visitor` for a principal with
 * no row) and `isModerator` joins off the `moderates` relation tuple. That is why they
 * ride on `UserFields` but are absent from `UserRow`.
 */
import type * as schema from "../../db/drizzle/schema.ts";
import type {Tier} from "../kunye/standing.ts";

type UserRecord = typeof schema.user.$inferSelect;

// The keys ARE the wire field names. `tier` rides as the stored value here; the
// resolver widens it.
const intrinsicFields = {
	id: (u) => u.id,
	email: (u) => u.email,
	name: (u) => u.name ?? null,
	image: (u) => u.image ?? null,
	username: (u) => u.username ?? null,
	tier: (u) => u.tier,
} satisfies Record<string, (u: UserRecord) => unknown>;

export type UserRow = {
	[K in keyof typeof intrinsicFields]: ReturnType<(typeof intrinsicFields)[K]>;
};

// `emailFailing` is SELF-scoped (#2693): only the `queries.me` resolver projects the
// reader's own state; every other `User` resolution stamps a flat `false`, so a non-self
// row never carries another account's delivery state.
export interface UserFields extends Omit<UserRow, "tier"> {
	tier: Tier;
	isModerator: boolean;
	emailFailing: boolean;
}

// Must stay a static literal — fate's `FateDataView` reads the field map off it. The
// `satisfies` makes any drift from `UserFields` a compile error.
export const userViewFields = {
	id: true,
	email: true,
	name: true,
	image: true,
	username: true,
	tier: true,
	isModerator: true,
	emailFailing: true,
} as const satisfies Record<keyof UserFields, true>;

export const toUserRow = (u: UserRecord): UserRow =>
	Object.fromEntries(
		(Object.keys(intrinsicFields) as Array<keyof typeof intrinsicFields>).map((f) => [
			f,
			intrinsicFields[f](u),
		]),
	) as UserRow;
