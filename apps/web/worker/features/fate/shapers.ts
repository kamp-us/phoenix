/**
 * fate shapers — barrel + cross-feature connection envelope.
 *
 * Per-feature wire-entity shapers live in their owning feature
 * (`features/<feature>/shapers.ts`); this barrel re-exports them so call sites
 * can keep importing from `worker/features/fate/shapers`.
 *
 * The connection envelope (`{items, pagination}`) is the one truly cross-feature
 * piece — `toConnection` is a generic over the keyset page shape every service
 * returns (`{rows, hasNextPage, endCursor}`) plus a per-node shaper. Services
 * page forward only, so `hasPrevious` is always `false` and the cursor is the
 * service keyset (opaque to the client).
 *
 * See `.patterns/fate-connections.md`, `.patterns/fate-mutations.md`.
 */

import type {ConnectionResult} from "@nkzw/fate/server";

export type {CommentFields, PostFields} from "../pano/shapers.ts";
export {toComment, toPost, toPostFromPage} from "../pano/shapers.ts";
export type {UserFields} from "../pasaport/shapers.ts";
export {toContributionRow, toUser} from "../pasaport/shapers.ts";
export type {DefinitionFields, TermFields} from "../sozluk/shapers.ts";
export {toDefinition, toTerm, toTermFromPage} from "../sozluk/shapers.ts";

/**
 * A service keyset page: forward-only rows plus the `hasNextPage` flag and the
 * opaque `endCursor`. The shape `toConnection` reshapes onto a `ConnectionResult`.
 */
export interface KeysetPage<Row> {
	rows: ReadonlyArray<Row>;
	hasNextPage: boolean;
	endCursor: string | null;
}

/**
 * Build a `ConnectionResult<Node>` from a service keyset page. `cursor` derives
 * each item's cursor from its source row (usually the keyset key); `node` shapes
 * the row into the wire entity. Services page forward only, so `hasPrevious` is
 * always `false`.
 */
export const toConnection = <Row, Node>(
	page: KeysetPage<Row>,
	cursor: (row: Row) => string,
	node: (row: Row) => Node,
): ConnectionResult<Node> => ({
	items: page.rows.map((row) => ({cursor: cursor(row), node: node(row)})),
	pagination: {
		hasNext: page.hasNextPage,
		hasPrevious: false,
		...(page.endCursor ? {nextCursor: page.endCursor} : {}),
	},
});
