/**
 * Pasaport wire-entity shapers. Every `{__typename, …}` literal is built here,
 * once, so the read/write paths can't drift out of byte-for-byte agreement
 * (`.patterns/fate-effect-operations.md`).
 */

import type {Tier} from "../kunye/standing.ts";
import {
	CONTRIBUTION_VARIANT_FIELD_NAMES,
	type ContributionNode,
	type ContributionRow,
	type ProfileRow,
} from "./Pasaport.ts";
import type {
	AccountDeletionReceipt,
	AuthorshipStanding,
	Profile,
	PromotionReceipt,
	User,
} from "./views.ts";

export interface UserFields {
	id: string;
	email: string;
	name: string | null;
	image: string | null;
	username: string | null;
	// The read-time authorship rank, resolved through `Kunye.tierOf` (#1297) — never
	// the untrusted session field. `Tier` (not `StoredTier`) so a row-missing principal
	// shapes as `visitor`.
	tier: Tier;
	// The SELF moderator signal (#1320), resolved off the `moderates` relation tuple
	// (`kunye/moderate.ts`'s `isModerator`) — server-authoritative, the viewer's own
	// status, never a `user.role` column (ADR 0107).
	isModerator: boolean;
}

export const toUser = (r: UserFields): User => ({
	__typename: "User",
	id: r.id,
	email: r.email,
	name: r.name,
	image: r.image,
	username: r.username,
	tier: r.tier,
	isModerator: r.isModerator,
});

// Stamps the client normalization key `id` === `userId` (a `Profile` is
// one-to-one with its user; codegen hardcodes `getId` to `record.id`). This is
// the one and only spelling of that invariant.
export const toProfile = (r: ProfileRow): Profile => ({
	__typename: "Profile",
	id: r.userId,
	userId: r.userId,
	username: r.username,
	displayName: r.displayName,
	image: r.image,
	totalKarma: r.totalKarma,
	definitionCount: r.definitionCount,
	postCount: r.postCount,
	commentCount: r.commentCount,
});

// The single spelling of the `account.delete` ack literal. The `id` is constant
// (`account:deleted`) — the receipt carries no per-user payload to leak.
export const toAccountDeletionReceipt = (): AccountDeletionReceipt => ({
	__typename: "AccountDeletionReceipt",
	id: "account:deleted",
	deleted: true,
});

// The single spelling of the çaylak→yazar promotion ack (#1206). The `id` carries
// the target user so two targets resolve as distinct receipts.
export const toPromotionReceipt = (r: {
	userId: string;
	promoted: boolean;
	vouchRecorded: boolean;
}): PromotionReceipt => ({
	__typename: "PromotionReceipt",
	id: `promotion:${r.userId}`,
	userId: r.userId,
	promoted: r.promoted,
	vouchRecorded: r.vouchRecorded,
});

// The single spelling of the çaylak-self authorship-standing aggregate (#1316).
// `id` === the user id (the client normalization key). Aggregate scalars only — the
// one-way-glass invariant is structural in `AuthorshipStanding` (no identity field
// exists to fill here).
export const toAuthorshipStanding = (r: {
	userId: string;
	karma: number;
	bar: number;
	vouchExists: boolean;
	inReviewCount: number;
}): AuthorshipStanding => ({
	__typename: "AuthorshipStanding",
	id: r.userId,
	karma: r.karma,
	bar: r.bar,
	vouchExists: r.vouchExists,
	inReviewCount: r.inReviewCount,
});

// Flatten a discriminated `ContributionNode` onto the flat `ContributionRow`
// (ADR 0018: fate has no union type). Every variant column starts `null`, then
// the node's own fields overlay — so the null-padding is derived from the
// `CONTRIBUTION_VARIANT_FIELD_NAMES` manifest, not hand-written per `case`. A
// forgotten field is a compile error at the manifest, not a silent wrong shape.
export function toContributionRow(node: ContributionNode): ContributionRow {
	const variantColumns = Object.fromEntries(
		CONTRIBUTION_VARIANT_FIELD_NAMES.map((name) => [name, null]),
	);
	const {kind, id, score, createdAt, sandboxed, ...variantFields} = node;
	return {
		...variantColumns,
		kind,
		id,
		score,
		createdAt,
		sandboxed,
		...variantFields,
	} as ContributionRow;
}
