/**
 * The walk's connection plane — fate's `paginationArgsSchema`,
 * `arrayToConnection`, and `getScopedArgs` reimplemented on Effect Schema.
 * What is mirrored byte for byte, and what is deliberately not reimplemented:
 * .patterns/fate-effect-interpreter.md § "The connection plane".
 */
import type {FateRequestError} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {internalArm} from "./WireError.ts";

type AnyRow = Record<string, unknown>;

type ArgsBag = {readonly [key: string]: unknown};

/** fate's `isRecord`, exactly (arrays excluded; `Walk.ts` carries its twin). */
const isRecord = (value: unknown): value is AnyRow =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** fate's `getScopedArgs` (`queryArgs.ts`), mirrored exactly. */
export const getScopedArgs = (args: ArgsBag | undefined, path: string): AnyRow | undefined => {
	if (!args) {
		return undefined;
	}
	let current: unknown = args;
	for (const segment of path.split(".")) {
		if (!isRecord(current)) {
			return undefined;
		}
		current = current[segment];
	}
	return isRecord(current) ? current : undefined;
};

const PAGINATION_ARG_KEYS = new Set(["after", "before", "first", "last"]);

/** fate's `extractPaginationArgs`: only the four keys reach the schema. */
const extractPaginationArgs = (args: ArgsBag | undefined): AnyRow =>
	args
		? Object.fromEntries(Object.entries(args).filter(([key]) => PAGINATION_ARG_KEYS.has(key)))
		: {};

/** zod's `z.number().int().positive()`: an integer strictly greater than 0. */
const PositiveInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

/** fate's `paginationArgsSchema`: the refines carry fate's messages AND fate's truthy predicates. */
export const ConnectionPaginationArgs = Schema.Struct({
	after: Schema.optional(Schema.String),
	before: Schema.optional(Schema.String),
	first: Schema.optional(PositiveInt),
	last: Schema.optional(PositiveInt),
}).check(
	Schema.makeFilter(
		({after, before}) =>
			!(after && before) || "Connection args can't include both 'after' and 'before'.",
	),
	Schema.makeFilter(
		({first, last}) => !(first && last) || "Connection args can't include both 'first' and 'last'.",
	),
);

export type ConnectionPaginationArgsValue = (typeof ConnectionPaginationArgs)["Type"];

const decodePagination = Schema.decodeUnknownEffect(ConnectionPaginationArgs);

/**
 * The schema failure stays in the error channel for the unit boundary tests;
 * {@link arrayToConnection} maps it onto the wire-visible internal arm.
 */
export const decodeConnectionPaginationArgs = (
	args: ArgsBag | undefined,
): Effect.Effect<ConnectionPaginationArgsValue, Schema.SchemaError> =>
	decodePagination(extractPaginationArgs(args));

/**
 * fate's wire-shaped connection envelope, literal field order included —
 * `nextCursor`/`previousCursor` hold `undefined` exactly where fate writes
 * `void 0` (JSON.stringify drops them identically on both backends).
 */
export interface ConnectionEnvelope {
	readonly items: ReadonlyArray<{readonly cursor: string; readonly node: unknown}>;
	readonly pagination: {
		readonly hasNext: boolean;
		readonly hasPrevious: boolean;
		readonly nextCursor: string | undefined;
		readonly previousCursor: string | undefined;
	};
}

/**
 * fate's default `getCursor` — `String(node.id)` with JavaScript's property
 * semantics: a nullish node THROWS (fate's TypeError, masked by the caller),
 * any other non-record reads `undefined` (primitives have no own `id`).
 */
const cursorOf = (node: unknown): string => {
	if (node === null || node === undefined) {
		// The message never reaches the wire — `arrayToConnection` masks every
		// throw onto `internalArm()` — so it is honest, not a V8 imitation.
		throw new TypeError("default cursor derivation: node is nullish, cannot read 'id'");
	}
	return String(isRecord(node) ? node.id : undefined);
};

/** The pure windowing body — may throw exactly where fate's would. */
const windowNodes = (
	nodes: ReadonlyArray<unknown>,
	paginationArgs: ConnectionPaginationArgsValue,
	hasPaginationKeys: boolean,
): ConnectionEnvelope => {
	if (!hasPaginationKeys) {
		return {
			items: nodes.map((node) => ({cursor: cursorOf(node), node})),
			pagination: {
				hasNext: false,
				hasPrevious: false,
				nextCursor: undefined,
				previousCursor: undefined,
			},
		};
	}
	const isBackward = paginationArgs.before !== undefined || paginationArgs.last !== undefined;
	const cursor = isBackward ? paginationArgs.before : paginationArgs.after;
	const pageSize = paginationArgs.first ?? paginationArgs.last ?? nodes.length;
	const cursorIndex =
		cursor === undefined ? -1 : nodes.findIndex((node) => cursorOf(node) === cursor);
	const selectedNodes =
		cursorIndex < 0
			? nodes
			: isBackward
				? nodes.slice(0, cursorIndex)
				: nodes.slice(cursorIndex + 1);
	const hasNext = selectedNodes.length > pageSize;
	const hasPrevious = nodes.length > selectedNodes.length;
	const items = (
		isBackward
			? selectedNodes.slice(Math.max(0, selectedNodes.length - pageSize))
			: selectedNodes.slice(0, pageSize)
	).map((node) => ({cursor: cursorOf(node), node}));
	const firstItem = items[0];
	const lastItem = items.at(-1);
	return {
		items,
		pagination: {
			hasNext: isBackward ? hasPrevious : hasNext,
			hasPrevious: isBackward ? hasNext : hasPrevious,
			nextCursor: lastItem?.cursor,
			previousCursor:
				(isBackward ? hasNext : hasPrevious) && firstItem ? firstItem.cursor : undefined,
		},
	};
};

/**
 * fate's `arrayToConnection`: any boundary rejection — and the nullish-node
 * TypeError — masks onto the wire-visible internal arm.
 */
export const arrayToConnection = (
	nodes: ReadonlyArray<unknown>,
	args: ArgsBag | undefined,
): Effect.Effect<ConnectionEnvelope, FateRequestError> => {
	const extracted = extractPaginationArgs(args);
	return decodePagination(extracted).pipe(
		Effect.mapError(() => internalArm()),
		Effect.flatMap((paginationArgs) =>
			Effect.try({
				try: () => windowNodes(nodes, paginationArgs, Object.keys(extracted).length > 0),
				catch: () => internalArm(),
			}),
		),
	);
};
