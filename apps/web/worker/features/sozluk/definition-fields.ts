/**
 * `Definition`'s one column→field map — the row mapper, the wire shaper, and the
 * view field declaration all derive from it, so a one-field change lands here
 * instead of in three hand-synced restatements.
 *
 * The readers absorb the record→wire naming divergence (`authorName`→`author`,
 * nullable timestamps→non-null `Date`). Viewer-scoped fields are NOT read here —
 * they are stamped downstream after their batched reads, which is what keeps the
 * N+1-avoidance split structural.
 */
import type * as schema from "../../db/drizzle/schema.ts";
import type {ReactionAggregate} from "../reaction/Reaction.ts";

type DefinitionRecord = typeof schema.definitionRecord.$inferSelect;

/** The record-derived wire fields, in `DefinitionView` order. The keys ARE the wire field names. */
const intrinsicFields = {
	id: (d) => d.id,
	body: (d) => d.body,
	score: (d) => d.score,
	author: (d) => d.authorName,
	authorId: (d) => d.authorId,
	createdAt: (d) => d.createdAt ?? new Date(0),
	updatedAt: (d) => d.updatedAt ?? d.createdAt ?? new Date(0),
} satisfies Record<string, (d: DefinitionRecord) => unknown>;

type IntrinsicRow = {[K in keyof typeof intrinsicFields]: ReturnType<(typeof intrinsicFields)[K]>};

/**
 * The record-derived row the definition reads share, plus the viewer-scoped fields
 * stamped downstream. Each optional field is `undefined` when the read didn't request it.
 */
export interface DefinitionRow extends IntrinsicRow {
	myVote?: boolean | null;
	/**
	 * `true` iff this definition is still sandboxed AND the viewer is its author.
	 * Owner-only by construction, so it never leaks review state to another viewer.
	 */
	sandboxed?: boolean;
	/**
	 * The author's LIVE handle, not the write-time `authorName` snapshot, so the client
	 * renders the current display name. `null` when the author has no profile handle.
	 */
	authorUsername?: string | null;
	authorDisplayName?: string | null;
	reactions?: ReactionAggregate;
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
 * Must stay a static literal — fate's `FateDataView` / `WorkerEntity` read the field
 * map off it, so a dynamically-built object breaks them. The `satisfies` pins it to
 * exactly `DefinitionRow`'s fields, making a drifted view a compile error.
 */
export const definitionViewFields = {
	id: true,
	body: true,
	score: true,
	author: true,
	authorId: true,
	createdAt: true,
	updatedAt: true,
	myVote: true,
	sandboxed: true,
	authorUsername: true,
	authorDisplayName: true,
	reactions: true,
} as const satisfies Record<keyof DefinitionRow, true>;

/** The single place the record→row mapping lives; viewer scalars are stamped elsewhere. */
export const toDefinitionRow = (d: DefinitionRecord): IntrinsicRow =>
	Object.fromEntries(
		(Object.keys(intrinsicFields) as Array<keyof typeof intrinsicFields>).map((f) => [
			f,
			intrinsicFields[f](d),
		]),
	) as IntrinsicRow;
