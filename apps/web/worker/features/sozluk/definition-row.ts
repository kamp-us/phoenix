/**
 * `definition_view` row mapping — the single source for the `DefinitionRow`
 * shape and the `definition_view` → `DefinitionRow` mapper shared by the
 * definition reads (`Sozluk.listDefinitionsKeyset`, `getDefinitionsByIds`).
 *
 * Kept beside `term-summary.ts` so the two definition/term row shapers live in
 * one place each and the read methods can't drift on field mapping.
 */
import type * as schema from "../../db/drizzle/schema.ts";

export interface DefinitionRow {
	id: string;
	score: number;
	body: string;
	author: string;
	/** Pasaport user id of the author — gates edit / delete affordances. */
	authorId: string;
	createdAt: Date;
	updatedAt: Date;
	/**
	 * `1` if the viewer has upvoted this definition, `null` otherwise. Populated
	 * by the fate batch reads (`getDefinitionsByIds`, `listDefinitionsKeyset`)
	 * when a `viewerId` is supplied — so a definition list resolves the
	 * `Definition.myVote` view field for the whole batch in one `user_vote` query
	 * instead of a per-row N+1. `undefined` when not requested (anonymous viewer
	 * / read paths that omit it).
	 */
	myVote?: number | null;
}

export interface TermPage {
	id: string;
	slug: string;
	title: string;
	totalDefinitions: number;
	totalScore: number;
	firstAt: Date;
	lastEdit: Date;
	definitions: DefinitionRow[];
}

export interface DefinitionConnectionPage {
	rows: DefinitionRow[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

/**
 * Shape a `definition_view` row onto a `DefinitionRow`, stamping `myVote` from
 * the batch-resolved `voted` set (`1` when the viewer upvoted, `null` otherwise;
 * always `null` for an anonymous viewer).
 */
export const toDefinitionRow = (
	d: typeof schema.definitionView.$inferSelect,
	voted: Set<string>,
	viewerId: string | null | undefined,
): DefinitionRow => ({
	id: d.id,
	score: d.score,
	body: d.body,
	author: d.authorName,
	authorId: d.authorId,
	createdAt: d.createdAt ?? new Date(0),
	updatedAt: d.updatedAt ?? d.createdAt ?? new Date(0),
	myVote: viewerId ? (voted.has(d.id) ? 1 : null) : null,
});
