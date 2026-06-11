/**
 * Cross-feature connection envelope — a leaf module (imports no feature code).
 *
 * The connection envelope (`{items, pagination}`) is the one truly cross-feature
 * shaping piece — `toConnection` is a generic over the keyset page shape every
 * service returns (`{rows, hasNextPage, endCursor}`) plus a per-node shaper.
 * Services page forward only, so `hasPrevious` is always `false` and the cursor
 * is the service keyset (opaque to the client).
 *
 * The input side lives here too: `connectionArgs()` is the `{first?, after?}`
 * args fragment every nested connection declares, and `keysetInput` turns the
 * decoded args into the service keyset input (default page size, `after` only
 * when present).
 *
 * Per-feature wire-entity shapers live in their owning feature
 * (`features/<feature>/shapers.ts`); features import this module directly so no
 * feature's import graph transitively pulls another feature's shapers.
 *
 * See `.patterns/fate-connections.md`, `.patterns/fate-mutations.md`.
 */

import type {ConnectionResult} from "@nkzw/fate/server";
import * as Schema from "effect/Schema";

/**
 * The nested-connection args struct every paged relation shares:
 * `{first?, after?}`, scoped under the relation's field path by fate's
 * `getScopedArgs` (`args.<relation>.{first,after}`).
 */
const ConnectionArgsSchema = Schema.Struct({
	first: Schema.optional(Schema.Number),
	after: Schema.optional(Schema.String),
});

/** The decoded nested-connection args (the relation field itself is optional). */
export type ConnectionArgs = Schema.Schema.Type<typeof ConnectionArgsSchema> | undefined;

/**
 * The nested-connection args fragment for a root-args struct — use as the
 * relation field's schema (`comments: connectionArgs()`). Decodes exactly the
 * inline `Schema.optional(Schema.Struct({first?, after?}))` it replaces.
 */
export const connectionArgs = () => Schema.optional(ConnectionArgsSchema);

/**
 * Build the service keyset input from decoded connection args: `first`
 * defaults to the caller's page size; `after` is spread in only when the
 * client actually paged, so services see the key only when a cursor exists.
 */
export const keysetInput = (
	cArgs: ConnectionArgs,
	defaultFirst: number,
): {first: number; after?: string} => ({
	first: cArgs?.first ?? defaultFirst,
	...(cArgs?.after !== undefined ? {after: cArgs.after} : {}),
});

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
