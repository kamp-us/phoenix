/**
 * `Definition`'s one column→field map — the single structure the row mapper
 * (`toDefinitionRow`), the wire shaper (`toDefinition` in `shapers.ts`), and the
 * view field declaration (`DefinitionView` in `views.ts`) all derive from, so a
 * one-field change touches this map instead of three hand-synced restatements
 * (#1126 AC#1, deferred from #1159).
 *
 * The map absorbs the per-source naming divergence the `shapers.ts` docblock
 * named: the DB record calls the author `authorName` and may leave the
 * timestamps null, while the wire field is `author` / a non-null `Date`. Each
 * intrinsic field carries a reader that maps a `definition_record` row onto its
 * wire value, so the divergence lives in the map, not at every call site.
 *
 * `myVote` is the viewer scalar — part of the view/wire field set (`definitionViewFields`)
 * but *not* read from the record here: it is stamped by `stampViewerScalars` after
 * the batched `user_vote` read (#1159, `viewer-scalars.ts`), the row→viewer-scalar
 * split that keeps the N+1-avoidance contract structural.
 */
import type * as schema from "../../db/drizzle/schema.ts";
import type {ReactionAggregate} from "../reaction/Reaction.ts";

type DefinitionRecord = typeof schema.definitionRecord.$inferSelect;

/**
 * The intrinsic (record-derived) wire fields, in `DefinitionView` order, each
 * mapping a `definition_record` row onto its wire value. The keys ARE the wire
 * field names; the readers absorb the `authorName`→`author` + null-timestamp
 * divergence.
 */
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
 * `DefinitionRow` — the record-derived row the definition reads share, plus the
 * `myVote` viewer scalar that `stampViewerScalars` adds downstream (`null` for an
 * anonymous viewer; `undefined` when not requested — never read from the record).
 */
export interface DefinitionRow extends IntrinsicRow {
	myVote?: boolean | null;
	/**
	 * The reaction aggregate (per-emoji counts + the viewer's own reaction), stamped
	 * by `stampReactionAggregate` after the batched `user_reaction` read (#1862) —
	 * `undefined` when not requested; the shaper fills the empty aggregate.
	 */
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
 * The view/wire field selection (`{id: true, …}`) — a static literal (fate's
 * `FateDataView` / `WorkerEntity` read the literal field map off this, so it
 * can't be a dynamically-built object). `satisfies Record<keyof DefinitionRow, true>`
 * pins it to exactly the row's fields: dropping a field here (or adding one to
 * `DefinitionRow` without listing it here) is a compile error, so the view stays
 * in lockstep with the row mapper.
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
	reactions: true,
} as const satisfies Record<keyof DefinitionRow, true>;

/**
 * Map a `definition_record` row onto its intrinsic `DefinitionRow` fields by
 * running every reader in the column→field map — the single place the
 * record→row mapping lives. `myVote` is the viewer scalar, stamped by
 * `stampViewerScalars` (#1159), not here — the row→viewer-scalar split keeps the
 * N+1-avoidance contract structural.
 */
export const toDefinitionRow = (d: DefinitionRecord): IntrinsicRow =>
	Object.fromEntries(
		(Object.keys(intrinsicFields) as Array<keyof typeof intrinsicFields>).map((f) => [
			f,
			intrinsicFields[f](d),
		]),
	) as IntrinsicRow;
