/**
 * Cross-feature connection envelope — a leaf module (imports no feature code,
 * so no feature's import graph transitively pulls another's shapers). Services
 * page forward only, so `hasPrevious` is always `false` and the cursor is the
 * opaque service keyset. See `.patterns/fate-connections.md`,
 * `.patterns/fate-effect-operations.md`.
 */

import type {ConnectionResult} from "@nkzw/fate/server";
import * as Schema from "effect/Schema";
import type {KeysetPage} from "../../db/keyset.ts";

export type {KeysetPage};

const ConnectionArgsSchema = Schema.Struct({
	first: Schema.optional(Schema.Number),
	after: Schema.optional(Schema.String),
});

export type ConnectionArgs = Schema.Schema.Type<typeof ConnectionArgsSchema> | undefined;

export const connectionArgs = () => Schema.optional(ConnectionArgsSchema);

/**
 * `after` is spread in only when the client actually paged, so services see the
 * cursor key only when one exists.
 */
export const keysetInput = (
	cArgs: ConnectionArgs,
	defaultFirst: number,
): {first: number; after?: string} => ({
	first: cArgs?.first ?? defaultFirst,
	...(cArgs?.after !== undefined ? {after: cArgs.after} : {}),
});

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
