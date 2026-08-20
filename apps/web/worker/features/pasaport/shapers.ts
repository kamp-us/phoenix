/**
 * Pasaport wire-entity shapers. Every `{__typename, …}` literal is built here, once,
 * so the read and write paths can't drift apart
 * (.patterns/fate-effect-operations.md).
 */

import type {PlatformRole} from "../kunye/moderate.ts";
import type {BanState} from "./ban.ts";
import type {EmailDeliveryState, FailingAddress} from "./email-delivery.ts";
import {
	CONTRIBUTION_VARIANT_FIELD_NAMES,
	type ContributionNode,
	type ContributionRow,
} from "./Pasaport.ts";
import type {ProfileRow} from "./profile-fields.ts";
import type {UserFields} from "./user-fields.ts";
import type {
	AccountDeletionReceipt,
	AuthorshipStanding,
	BanStateEntity,
	EmailDeliveryStateEntity,
	FailingAddressEntity,
	Profile,
	PromotionReceipt,
	RoleStateEntity,
	User,
} from "./views.ts";

// `emailFailing` is truthful only on the self `me` read and a flat `false` on every
// other `User`, so a row never carries another account's delivery-state (#2693).
export const toUser = (r: UserFields): User => ({
	__typename: "User",
	id: r.id,
	email: r.email,
	name: r.name,
	image: r.image,
	username: r.username,
	tier: r.tier,
	isModerator: r.isModerator,
	emailFailing: r.emailFailing,
});

// `id` === `userId`: a `Profile` is one-to-one with its user, and codegen hardcodes
// `getId` to `record.id`. This is the only spelling of that invariant.
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

// The `id` is constant on purpose — the receipt carries no per-user payload to leak.
export const toAccountDeletionReceipt = (): AccountDeletionReceipt => ({
	__typename: "AccountDeletionReceipt",
	id: "account:deleted",
	deleted: true,
});

// The `id` carries the target user, so two targets resolve as distinct receipts.
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

// Aggregate scalars only — the one-way-glass invariant is structural in
// `AuthorshipStanding`, which has no identity field to fill (#1316).
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

// The admin read and the ban/unban ack resolve the SAME entity, keyed on the target
// user id, so an ack reconciles the surface's earlier read (epic #968).
export const toBanState = (userId: string, state: BanState): BanStateEntity => ({
	__typename: "BanState",
	id: userId,
	banned: state.banned,
	reason: state.reason,
	expiresAt: state.expiresAt === null ? null : state.expiresAt.getTime(),
});

// Keyed on the target user id, so the ack reconciles the SAME account the roster
// lists (#3522).
export const toRoleState = (userId: string, role: PlatformRole): RoleStateEntity => ({
	__typename: "RoleState",
	id: userId,
	role,
});

// Mark and clear resolve the SAME entity, keyed on the target address, so an ack
// reconciles the roll-up's earlier read. Never the log rows (epic #2687).
export const toEmailDeliveryState = (
	address: string,
	state: EmailDeliveryState,
): EmailDeliveryStateEntity => ({
	__typename: "EmailDeliveryState",
	id: address,
	failing: state.failing,
	reason: state.reason,
});

// `id` === the address, the client normalization key.
export const toFailingAddress = (row: FailingAddress): FailingAddressEntity => ({
	__typename: "FailingAddress",
	id: row.address,
	address: row.address,
	userId: row.userId,
	reason: row.reason,
	since: row.since.getTime(),
});

// Null-padding is derived from the `CONTRIBUTION_VARIANT_FIELD_NAMES` manifest, never
// hand-written per `case`, so a forgotten field is a compile error at the manifest
// rather than a silent wrong shape. See ADR 0018.
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
