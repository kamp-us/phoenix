/**
 * Pasaport wire-entity shapers — `User`, `Profile` + `toContributionRow`.
 *
 * Every `{__typename: "User", …}` / `{__typename: "Profile", …}` literal is
 * built here, once; resolvers, sources, and mutations call the shaper instead
 * of hand-restating the literal so adding or renaming a field is a one-line
 * edit and the read/write paths can never drift out of byte-for-byte
 * agreement.
 *
 * `toContributionRow` flattens the discriminated `ContributionNode` (produced
 * by the service) into the flat `ContributionRow` the fate `Profile.contributions`
 * data view masks — same rows, same keyset, same cursor (ADR 0018; fate has no
 * union type).
 *
 * See `.patterns/fate-effect-operations.md`.
 */

import type {ContributionNode, ContributionRow, ProfileRow} from "./Pasaport.ts";
import type {Profile, User} from "./views.ts";

export interface UserFields {
	id: string;
	email: string;
	name: string | null;
	image: string | null;
	username: string | null;
}

/** Shape resolved user fields into the `User` wire entity. */
export const toUser = (r: UserFields): User => ({
	__typename: "User",
	id: r.id,
	email: r.email,
	name: r.name,
	image: r.image,
	username: r.username,
});

/**
 * Shape a service `ProfileRow` into the `Profile` wire entity, stamping the
 * client normalization key `id` === `userId` (a `Profile` is one-to-one with
 * its user; the codegen hardcodes `getId` to `record.id` — see `views.ts`).
 * The invariant has exactly one spelling: here.
 */
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

/**
 * Flatten a discriminated `ContributionNode` into the flat `ContributionRow`
 * the fate view masks. The discriminant `kind` is carried straight through;
 * non-applicable variant fields are `null`.
 */
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
