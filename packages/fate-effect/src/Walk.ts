/**
 * The selection walk — fate's byId plane reimplemented as an Effect program,
 * with every source load riding `Request.Class` + `RequestResolver`. The
 * mirrored semantics, the batching contract, the error taxonomy and the
 * deliberate divergences are owned by `.patterns/fate-effect-interpreter.md`.
 *
 * ## Span design (deliberate)
 *
 * The internal helpers (`resolveNode`, `toConnectionResult`,
 * `callViewFunction`, …) are span-less arrow functions returning
 * `Effect.gen` ON PURPOSE. effect-smol's `LLMS.md` prefers `Effect.fn` for
 * named Effect-returning functions, but these recurse per row and per
 * relation — wrapping them would emit a span per node visited, polluting
 * traces and changing the span tree the observability tests pin. Spans live
 * at the operation/source boundaries (`Fate.*` constructors, the
 * interpreter's dispatch), not inside the walk. Don't "fix" this to
 * `Effect.fn`.
 */
import {FateRequestError} from "@nkzw/fate/server";
import {Effect, Exit, Request, RequestResolver} from "effect";
import {arrayToConnection, getScopedArgs} from "./Connection.ts";
import type {ProtocolByIdOperation} from "./Protocol.ts";
import {provideRequestPair} from "./Provision.ts";
import type {FateRequestContext} from "./RequestContext.ts";
import type {AnyFateSourceEntry, AnyFateSourceHandlers, FateServerService} from "./Server.ts";
import {internalArm} from "./WireError.ts";

type AnyRow = Record<string, unknown>;

type WalkArgs = {readonly [key: string]: unknown} | undefined;

/** fate's `isRecord`, exactly (arrays excluded). */
const isRecord = (value: unknown): value is AnyRow =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * The structural face of a (possibly nested) runtime view the walk reads:
 * fate's own `isDataViewField` checks nothing beyond `"fields" in field`.
 */
interface ViewLike {
	readonly fields: AnyRow;
}

const isViewField = (field: unknown): field is ViewLike =>
	isRecord(field) && "fields" in field && isRecord(field.fields);

const isResolverField = (field: unknown): field is AnyRow =>
	isRecord(field) && field.kind === "resolver";

const isComputedField = (field: unknown): field is AnyRow =>
	isRecord(field) && field.kind === "computed";

/** fate's `getValueAtPath` (dotted lookup, `undefined` past non-records). */
const getValueAtPath = (item: unknown, path: string): unknown => {
	let current = item;
	for (const segment of path.split(".")) {
		if (!isRecord(current)) {
			return undefined;
		}
		current = current[segment];
	}
	return current;
};

/** fate's `isConnectionResult` (the already-shaped connection envelope). */
const isConnectionResult = (value: unknown): value is AnyRow & {readonly items: Array<unknown>} =>
	isRecord(value) &&
	Array.isArray(value.items) &&
	isRecord(value.pagination) &&
	typeof value.pagination.hasNext === "boolean" &&
	typeof value.pagination.hasPrevious === "boolean";

/** One node of the selection tree — fate's `SelectedNode`, walk-relevant half. */
interface SelectionNode {
	readonly view: ViewLike;
	readonly selectedFields: Set<string>;
	readonly resolvers: Map<string, AnyRow>;
	readonly computeds: Map<string, AnyRow>;
	readonly relations: Map<string, SelectionNode>;
}

interface SelectionPlan {
	readonly root: SelectionNode;
	readonly selectedPaths: Set<string>;
}

const makeNode = (view: ViewLike): SelectionNode => ({
	view,
	selectedFields: new Set(),
	resolvers: new Map(),
	computeds: new Map(),
	relations: new Map(),
});

/** fate's `assignPath`: route one dotted select path into the node tree. */
const assignPath = (
	node: SelectionNode,
	segments: ReadonlyArray<string>,
	path: string | null,
	selectedPaths: Set<string>,
): void => {
	const [segment, ...rest] = segments;
	if (segment === undefined) {
		return;
	}
	const field = node.view.fields[segment];
	if (!field) {
		return;
	}
	const nextPath = path ? `${path}.${segment}` : segment;
	if (isResolverField(field)) {
		if (rest.length === 0) {
			node.resolvers.set(segment, field);
			selectedPaths.add(nextPath);
		}
		return;
	}
	if (isComputedField(field)) {
		if (rest.length === 0) {
			node.computeds.set(segment, field);
			selectedPaths.add(nextPath);
		}
		return;
	}
	if (isViewField(field)) {
		let relationNode = node.relations.get(segment);
		if (!relationNode) {
			relationNode = makeNode(field);
			node.relations.set(segment, relationNode);
		}
		if (field.fields.id === true) {
			relationNode.selectedFields.add("id");
			selectedPaths.add(`${nextPath}.id`);
		}
		if (rest.length === 0) {
			selectedPaths.add(nextPath);
			return;
		}
		assignPath(relationNode, rest, nextPath, selectedPaths);
		return;
	}
	if (rest.length === 0) {
		node.selectedFields.add(segment);
		selectedPaths.add(nextPath);
	}
};

const buildSelectionPlan = (view: ViewLike, select: ReadonlyArray<string>): SelectionPlan => {
	const selectedPaths = new Set<string>();
	selectedPaths.add("id");
	const root = makeNode(view);
	root.selectedFields.add("id");
	for (const path of select) {
		if (!path) {
			continue;
		}
		assignPath(root, path.split("."), null, selectedPaths);
	}
	return {root, selectedPaths};
};

/**
 * fate's `toProtocolError` mask for walk-internal throws: a
 * `FateRequestError` keeps itself; anything else is fate's OWN internal arm.
 * (These errors never pass through `encodeWireError` in fate — the taxonomy
 * is in `.patterns/fate-effect-interpreter.md`.)
 */
const walkError = (error: unknown): FateRequestError =>
	error instanceof FateRequestError ? error : internalArm();

/**
 * Invoke one kernel view callback (`authorize`/`resolve` — promise-shaped or
 * plain). A non-callable slot fails like fate's own `TypeError` would: the
 * masked internal arm.
 */
const callViewFunction = (
	fn: unknown,
	args: ReadonlyArray<unknown>,
): Effect.Effect<unknown, FateRequestError> =>
	typeof fn === "function"
		? Effect.tryPromise({
				try: async (): Promise<unknown> => fn(...args),
				catch: walkError,
			})
		: Effect.fail(internalArm());

/**
 * fate's `getComputedDeps`, minus the hidden computed-state read (a divergence
 * documented in `.patterns/fate-effect-interpreter.md`): `count` selections
 * read `_count.<relation>` (default 0),
 * field selections read their dotted path.
 */
const getComputedDeps = (item: AnyRow, select: unknown): AnyRow => {
	const deps: AnyRow = {};
	if (!isRecord(select)) {
		return deps;
	}
	for (const [name, selection] of Object.entries(select)) {
		if (!isRecord(selection)) {
			continue;
		}
		if (selection.kind === "count") {
			deps[name] = getValueAtPath(item, `_count.${String(selection.relation)}`) ?? 0;
			continue;
		}
		deps[name] =
			typeof selection.path === "string" ? getValueAtPath(item, selection.path) : undefined;
	}
	return deps;
};

interface WalkOptions {
	readonly args: WalkArgs;
	readonly context: FateRequestContext;
}

/** fate's `resolveNode` as an Effect: resolvers → computeds → relations. */
const resolveNode = (
	item: unknown,
	node: SelectionNode,
	options: WalkOptions,
): Effect.Effect<unknown, FateRequestError> =>
	Effect.gen(function* () {
		if (!isRecord(item)) {
			return item;
		}
		const row: AnyRow = item;
		let result: AnyRow | null = null;
		const assign = (key: string, value: unknown): void => {
			if (!result) {
				result = {...row};
			}
			result[key] = value;
		};
		const getItem = (): AnyRow => result ?? row;
		for (const [field, config] of node.resolvers) {
			if (config.authorize) {
				const allowed = yield* callViewFunction(config.authorize, [
					getItem(),
					options.context,
					options.args,
				]);
				if (!allowed) {
					assign(field, null);
					continue;
				}
			}
			const value = yield* callViewFunction(config.resolve, [
				getItem(),
				options.context,
				options.args,
			]);
			if (value !== undefined) {
				assign(field, value);
			}
		}
		for (const [field, config] of node.computeds) {
			if (config.authorize) {
				const allowed = yield* callViewFunction(config.authorize, [
					getItem(),
					options.context,
					options.args,
				]);
				if (!allowed) {
					assign(field, null);
					continue;
				}
			}
			const value = yield* callViewFunction(config.resolve, [
				getItem(),
				getComputedDeps(getItem(), config.select),
				options.context,
				options.args,
			]);
			if (value !== undefined) {
				assign(field, value);
			}
		}
		for (const [field, relationNode] of node.relations) {
			const current = getItem()[field];
			if (isConnectionResult(current)) {
				const items = yield* Effect.forEach(
					current.items,
					(entry) =>
						Effect.gen(function* () {
							if (!isRecord(entry)) {
								return entry;
							}
							return {...entry, node: yield* resolveNode(entry.node, relationNode, options)};
						}),
					{concurrency: 1},
				);
				assign(field, {...current, items});
				continue;
			}
			if (Array.isArray(current)) {
				assign(
					field,
					yield* Effect.forEach(current, (entry) => resolveNode(entry, relationNode, options), {
						concurrency: 1,
					}),
				);
				continue;
			}
			if (current && typeof current === "object") {
				assign(field, yield* resolveNode(current, relationNode, options));
			}
		}
		return getItem();
	});

/**
 * fate's `filterToViewFields`: mask a resolved item to the selected paths.
 * Output keys follow the VIEW's field declaration order — the byId plane's
 * serialization-order mechanism.
 */
const filterToViewFields = (
	item: unknown,
	view: ViewLike,
	selectedPaths: ReadonlySet<string>,
	prefix: string | null = null,
): unknown => {
	if (!isRecord(item)) {
		return item;
	}
	const filtered: AnyRow = {};
	for (const [field, config] of Object.entries(view.fields)) {
		const path = prefix ? `${prefix}.${field}` : field;
		let hasSelection = selectedPaths.has(path);
		if (!hasSelection) {
			for (const selected of selectedPaths) {
				if (selected.startsWith(`${path}.`)) {
					hasSelection = true;
					break;
				}
			}
		}
		if (!hasSelection) {
			continue;
		}
		if (!(field in item)) {
			continue;
		}
		const value = item[field];
		if (isViewField(config)) {
			if (isConnectionResult(value)) {
				filtered[field] = {
					...value,
					items: value.items.map((entry) =>
						isRecord(entry)
							? {
									...entry,
									node: isRecord(entry.node)
										? filterToViewFields(entry.node, config, selectedPaths, path)
										: entry.node,
								}
							: entry,
					),
				};
				continue;
			}
			if (Array.isArray(value)) {
				filtered[field] = value.map((entry) =>
					isRecord(entry) ? filterToViewFields(entry, config, selectedPaths, path) : entry,
				);
				continue;
			}
			if (isRecord(value)) {
				filtered[field] = filterToViewFields(value, config, selectedPaths, path);
				continue;
			}
		}
		filtered[field] = value;
	}
	return filtered;
};

/**
 * fate's `toConnectionResult` over a masked item: already-shaped connection
 * envelopes pass through, recursing per entry node; a selected list-kind
 * field holding a RAW array is fate's `arrayToConnection` — the connection
 * plane (`Connection.ts`), windowed by the OPERATION args scoped to the
 * field's full dotted path (`getScopedArgs`). The operation-level `args` and
 * the running `path` thread through every recursion exactly as fate's do, so
 * a connection nested anywhere in the tree scopes off the same root bag.
 */
const toConnectionResult = (
	item: unknown,
	view: ViewLike,
	args: WalkArgs,
	path: string | null,
): Effect.Effect<unknown, FateRequestError> =>
	Effect.gen(function* () {
		if (!isRecord(item)) {
			return item;
		}
		const row: AnyRow = item;
		let result: AnyRow | null = null;
		const assign = (key: string, value: unknown): void => {
			if (!result) {
				result = {...row};
			}
			result[key] = value;
		};
		for (const [field, config] of Object.entries(view.fields)) {
			if (!isViewField(config)) {
				continue;
			}
			const current = (result ?? row)[field];
			const nextPath = path ? `${path}.${field}` : field;
			if (isRecord(config) && config.kind === "list") {
				if (isConnectionResult(current)) {
					const items = yield* Effect.forEach(
						current.items,
						(entry) =>
							Effect.gen(function* () {
								if (!isRecord(entry)) {
									return entry;
								}
								return {
									...entry,
									node: yield* toConnectionResult(entry.node, config, args, nextPath),
								};
							}),
						{concurrency: 1},
					);
					assign(field, {...current, items});
					continue;
				}
				if (!Array.isArray(current)) {
					continue;
				}
				const nodes = yield* Effect.forEach(
					current,
					(entry) => toConnectionResult(entry, config, args, nextPath),
					{concurrency: 1},
				);
				assign(field, yield* arrayToConnection(nodes, getScopedArgs(args, nextPath)));
				continue;
			}
			if (Array.isArray(current)) {
				assign(
					field,
					yield* Effect.forEach(
						current,
						(entry) => toConnectionResult(entry, config, args, nextPath),
						{concurrency: 1},
					),
				);
				continue;
			}
			if (isRecord(current)) {
				assign(field, yield* toConnectionResult(current, config, args, nextPath));
			}
		}
		return result ?? row;
	});

/**
 * One byId operation's load: the source entry (batch grouping is by entry
 * identity) and the operation's coerced ids. Success is the rows fate's
 * `resolveSourceByIds` would hand `resolveMany`; the error channel carries
 * the walk's wire-shaped failures (capability-less arm), while source-handler
 * defects ride the cause.
 */
class SourceRowsRequest extends Request.Class<
	{
		readonly source: AnyFateSourceEntry;
		readonly ids: ReadonlyArray<string>;
	},
	ReadonlyArray<AnyRow>,
	FateRequestError
> {}

type SourceRowsEntry = Request.Entry<SourceRowsRequest>;

/** Union the batch's ids: first-arrival order, deduplicated (the dedupe AC). */
const uniqueIdsOf = (group: ReadonlyArray<SourceRowsEntry>): Array<string> => {
	const seen = new Set<string>();
	const ids: Array<string> = [];
	for (const entry of group) {
		for (const id of entry.request.ids) {
			if (!seen.has(id)) {
				seen.add(id);
				ids.push(id);
			}
		}
	}
	return ids;
};

/**
 * What `makeWalk` hands the dispatch loop: the interpreted byId plane. Every
 * failure inside is wire-shaped already (`loadRows`/`resolveNode`/
 * `toConnectionResult` are all typed so), so the error channel is pinned to
 * `FateRequestError` — the byId plane's error taxonomy in the type.
 */
export interface FateWalk {
	readonly byId: (operation: ProtocolByIdOperation) => Effect.Effect<unknown, FateRequestError>;
}

/**
 * Construct the per-request walk: the source lookup table, the batching
 * resolver (ONE instance — the batch window), and the byId operation
 * pipeline. Called once per `handleRequest`, BEFORE the dispatch loop, so
 * concurrent operations share the window.
 */
export const makeWalk = (server: FateServerService, context: FateRequestContext): FateWalk => {
	const sourcesByType = new Map<string, AnyFateSourceEntry>();
	for (const entry of server.sources) {
		sourcesByType.set(entry.definition.view.typeName, entry);
	}

	// ONE provision pipeline per request (`Provision.ts` — the pair as request
	// VALUES over the captured services; carries the erased→kernel re-pin).
	const provide = provideRequestPair(context, server.services);

	const runGroup = (
		source: AnyFateSourceEntry,
		group: ReadonlyArray<SourceRowsEntry>,
	): Effect.Effect<void> =>
		Effect.gen(function* () {
			const handlers: AnyFateSourceHandlers = source.handlers;
			const uniqueIds = uniqueIdsOf(group);
			if (handlers.byIds) {
				// fate's byIds arm: one call; rows verbatim for a lone operation,
				// per-operation id-set masking (source order) for a merged window.
				const exit = yield* Effect.exit(provide(handlers.byIds(uniqueIds)));
				if (Exit.isSuccess(exit)) {
					const rows = exit.value;
					const lone = group.length === 1 ? group[0] : undefined;
					if (lone !== undefined) {
						lone.completeUnsafe(Exit.succeed(rows));
						return;
					}
					const idField = source.definition.id;
					for (const entry of group) {
						const wanted = new Set(entry.request.ids);
						entry.completeUnsafe(
							Exit.succeed(rows.filter((rowValue) => wanted.has(String(rowValue[idField])))),
						);
					}
					return;
				}
				for (const entry of group) {
					entry.completeUnsafe(Exit.failCause(exit.cause));
				}
				return;
			}
			const loadById = handlers.byId;
			if (loadById) {
				// fate's byId fallback arm, deduplicated: each unique id loads once;
				// each operation reassembles its own ids (order and duplicates kept,
				// nulls dropped); a failed id fails exactly its askers.
				const idExits = yield* Effect.forEach(
					uniqueIds,
					(id): Effect.Effect<readonly [string, Exit.Exit<AnyRow | null>]> =>
						Effect.exit(provide(loadById(id))).pipe(Effect.map((exit) => [id, exit])),
					{concurrency: "unbounded"},
				);
				const exits = new Map(idExits);
				for (const entry of group) {
					const rows: Array<AnyRow> = [];
					let failed: Exit.Exit<never> | undefined;
					for (const id of entry.request.ids) {
						const exit = exits.get(id);
						if (exit === undefined) {
							continue;
						}
						if (!Exit.isSuccess(exit)) {
							failed = Exit.failCause(exit.cause);
							break;
						}
						if (exit.value) {
							rows.push(exit.value);
						}
					}
					entry.completeUnsafe(failed ?? Exit.succeed(rows));
				}
				return;
			}
			// Capability-less source: fate throws a plain Error here and its
			// `toProtocolError` masks it — the internal arm, fixed message.
			for (const entry of group) {
				entry.completeUnsafe(Exit.fail(internalArm()));
			}
		});

	const resolver = RequestResolver.make<SourceRowsRequest>((entries) =>
		Effect.gen(function* () {
			const groups = new Map<AnyFateSourceEntry, Array<SourceRowsEntry>>();
			for (const entry of entries) {
				const group = groups.get(entry.request.source) ?? [];
				group.push(entry);
				groups.set(entry.request.source, group);
			}
			yield* Effect.forEach(groups, ([source, group]) => runGroup(source, group), {
				concurrency: "unbounded",
			});
		}),
	);

	const loadRows = (
		source: AnyFateSourceEntry,
		ids: ReadonlyArray<string>,
	): Effect.Effect<ReadonlyArray<AnyRow>, FateRequestError> =>
		Effect.request(new SourceRowsRequest({source, ids}), resolver);

	const byId = (operation: ProtocolByIdOperation): Effect.Effect<unknown, FateRequestError> =>
		Effect.gen(function* () {
			// fate's dispatch gate: `!operation.type || !operation.ids` — after the
			// protocol decode only the empty-string type can still be falsy.
			if (!operation.type) {
				return yield* Effect.fail(
					new FateRequestError("BAD_REQUEST", "byId operations require type and ids."),
				);
			}
			const source = sourcesByType.get(operation.type);
			if (source === undefined) {
				return yield* Effect.fail(
					new FateRequestError("NOT_FOUND", `No source registered for '${operation.type}'.`),
				);
			}
			const ids = operation.ids.map(String);
			const view = source.definition.view;
			const plan = buildSelectionPlan(view, operation.select);
			const rows = yield* loadRows(source, ids);
			// fate's `plan.resolveMany`: every row through resolve → mask → wrap.
			return yield* Effect.forEach(
				rows,
				(rowValue) =>
					resolveNode(rowValue, plan.root, {args: operation.args, context}).pipe(
						Effect.map((resolved) => filterToViewFields(resolved, view, plan.selectedPaths)),
						Effect.flatMap((masked) => toConnectionResult(masked, view, operation.args, null)),
					),
				{concurrency: "unbounded"},
			);
		});

	return {byId};
};
