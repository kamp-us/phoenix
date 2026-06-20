/**
 * The `DefinitionRow` shape and the `definition_record` → `DefinitionRow` mapper,
 * shared by the definition reads so they can't drift on field mapping.
 */
import type * as schema from "../../db/drizzle/schema.ts";

export interface DefinitionRow {
	id: string;
	score: number;
	body: string;
	author: string;
	authorId: string;
	createdAt: Date;
	updatedAt: Date;
	// `1` upvoted / `null` not, stamped by the batch reads when a `viewerId` is
	// supplied (one `user_vote` query for the whole list, not a per-row N+1).
	// `undefined` when not requested (anonymous / read paths that omit it).
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

export const toDefinitionRow = (
	d: typeof schema.definitionRecord.$inferSelect,
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
