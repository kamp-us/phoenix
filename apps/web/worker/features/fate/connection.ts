/**
 * Cross-feature connection envelope — a leaf module (imports no feature code).
 *
 * The connection envelope (`{items, pagination}`) is the one truly cross-feature
 * shaping piece — `toConnection` is a generic over the keyset page shape every
 * service returns (`{rows, hasNextPage, endCursor}`) plus a per-node shaper.
 * Services page forward only, so `hasPrevious` is always `false` and the cursor
 * is the service keyset (opaque to the client).
 *
 * Per-feature wire-entity shapers live in their owning feature
 * (`features/<feature>/shapers.ts`); features import this module directly so no
 * feature's import graph transitively pulls another feature's shapers.
 *
 * See `.patterns/fate-connections.md`, `.patterns/fate-mutations.md`.
 */

import type {ConnectionResult} from "@nkzw/fate/server";

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
