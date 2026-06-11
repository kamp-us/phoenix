/**
 * Pasaport wire-entity shapers — `User` + `toContributionRow`.
 *
 * Every `{__typename: "User", …}` literal is built here, once; resolvers and
 * mutations call the shaper instead of hand-restating the literal so adding or
 * renaming a field is a one-line edit and the read/write paths can never drift
 * out of byte-for-byte agreement.
 *
 * `toContributionRow` flattens the discriminated `ContributionNode` (produced
 * by the service) into the flat `ContributionRow` the fate `Profile.contributions`
 * data view masks — same rows, same keyset, same cursor (ADR 0018; fate has no
 * union type).
 *
 * See `.patterns/fate-mutations.md`.
 */

import type {ContributionNode, ContributionRow} from "./Pasaport.ts";
import type {User} from "./views.ts";

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
