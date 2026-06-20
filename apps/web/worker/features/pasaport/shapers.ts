/**
 * Pasaport wire-entity shapers. Every `{__typename, …}` literal is built here,
 * once, so the read/write paths can't drift out of byte-for-byte agreement
 * (`.patterns/fate-effect-operations.md`).
 */

import type {ContributionNode, ContributionRow, ProfileRow} from "./Pasaport.ts";
import type {AccountDeletionReceipt, Profile, User} from "./views.ts";

export interface UserFields {
	id: string;
	email: string;
	name: string | null;
	image: string | null;
	username: string | null;
}

export const toUser = (r: UserFields): User => ({
	__typename: "User",
	id: r.id,
	email: r.email,
	name: r.name,
	image: r.image,
	username: r.username,
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

// Flatten a discriminated `ContributionNode` into the flat `ContributionRow`;
// non-applicable variant fields are `null`.
export function toContributionRow(node: ContributionNode): ContributionRow {
	const base = {kind: node.kind, id: node.id, score: node.score, createdAt: node.createdAt};
	switch (node.kind) {
		case "definition":
			return {
				...base,
				bodyExcerpt: node.bodyExcerpt,
				termSlug: node.termSlug,
				termTitle: node.termTitle,
				title: null,
				slug: null,
				postId: null,
				postTitle: null,
			};
		case "post":
			return {
				...base,
				bodyExcerpt: node.bodyExcerpt,
				termSlug: null,
				termTitle: null,
				title: node.title,
				slug: node.slug,
				postId: null,
				postTitle: null,
			};
		case "comment":
			return {
				...base,
				bodyExcerpt: node.bodyExcerpt,
				termSlug: null,
				termTitle: null,
				title: null,
				slug: null,
				postId: node.postId,
				postTitle: node.postTitle,
			};
	}
}
