/**
 * The selection walk — fate's byId plane (`executeOperation`'s byId arm →
 * `resolveSourceByIds` → `resolveNode`/`filterToViewFields`/
 * `toConnectionResult`) reimplemented as an Effect program, with every source
 * load riding `Request.Class` + `RequestResolver`.
 * This is where N+1 dies: the batch window is ONE protocol request
 * (`makeWalk` is constructed once per `FateInterpreter.handleRequest`, so the
 * resolver instance — and with it the window — never spans requests), and ids
 * are deduplicated before they reach the source.
 *
 * ## What is mirrored, byte for byte (the walk oracle enforces it)
 *
 *   - **Dispatch order**: falsy `type` → fate's `BAD_REQUEST` ("byId
 *     operations require type and ids."), then the source lookup → fate's
 *     `NOT_FOUND`, then `ids.map(String)` — numeric wire ids coerce BEFORE
 *     the source sees them.
 *   - **The selection plan** (fate's `createViewPlan`/`assignPath`): `"id"`
 *     is always selected; resolver/computed fields register at terminal
 *     segments only; a selected ref auto-selects the child view's `id`;
 *     unknown paths and empty segments are ignored.
 *   - **`resolveNode`**: resolver fields run `authorize` first (falsy →
 *     `null`, resolve skipped), `undefined` results stay absent, computed
 *     fields receive select-derived deps, relation nodes recurse into
 *     records, arrays, and already-shaped connection results.
 *   - **`filterToViewFields`**: masking emits keys in the VIEW's field
 *     declaration order — the byId plane's serialization-order mechanism
 *     (the named-operation planes get theirs from the `Protocol.ts` structs).
 *   - **`toConnectionResult`** (the connection plane, `Connection.ts`): a
 *     selected list-kind field holding a RAW array wraps via fate's
 *     `arrayToConnection`, windowed by the operation args scoped to the
 *     field's dotted path (`getScopedArgs`); an already-shaped connection
 *     envelope passes through, recursing per entry node. Pagination args
 *     decode through Effect Schema with fate's exact accept/reject boundary;
 *     a rejected bag is fate's masked internal arm on the wire.
 *   - **The error taxonomy**: a view callback throwing a `FateRequestError`
 *     passes through verbatim; any other callback throw is fate's OWN
 *     `toProtocolError` arm (`INTERNAL_ERROR` / "Internal server error.") —
 *     NOT the annotation codec's arm, because in fate these errors never pass
 *     through `encodeWireError`. Source-handler defects, by contrast, reach
 *     the operation's exit as raw causes and collapse through
 *     `encodeWireError` exactly as the v1 compiled executors do
 *     (`INTERNAL_SERVER_ERROR` / "Something went wrong."). A capability-less
 *     source (the `contributionSource` shape) is fate's internal arm, the
 *     fixed message — fate throws a plain `Error` there and masks it.
 *
 * ## The batching contract
 *
 * One `RequestResolver` per protocol request; one `Request` per byId
 * operation (`{source, ids}`). `runAll` groups entries by source entry
 * (identity), unions their ids (first-arrival order, deduplicated), and
 * mirrors fate's two executor arms:
 *
 *   - **`byIds`-capable**: ONE call with the deduplicated union. A
 *     single-operation batch completes with the source's rows verbatim
 *     (exactly fate's `resolveSourceByIds`); a merged batch completes each
 *     operation with the rows whose primary key (the definition's `id`
 *     field) is in that operation's id set, in SOURCE-RETURN order. This is
 *     byte-equal to fate whenever the source is **membership-stable** (the
 *     returned rows are a function of the id SET — every SQL `IN`-shaped
 *     loader, i.e. every phoenix source, qualifies).
 *   - **`byId`-only**: one call per UNIQUE id across the window (fate calls
 *     per id per operation, duplicates included); each operation's rows are
 *     its own ids' hits in ids order, duplicates preserved, nulls dropped —
 *     fate's `flatMap` arm exactly. A failed id fails exactly the operations
 *     that asked for it.
 *
 * Loads provide the per-request pair + captured services themselves (the
 * ONE shared provision pipeline — `provideRequestPair`, `Provision.ts`), so
 * the resolver fiber needs no ambient context. No runtime is owned here — the conversion-point rule
 * (`Executor.test.ts`) covers this module automatically.
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
 *
 * ## Deliberately NOT mirrored (documented divergences)
 *
 *   - **Source lookup**: fate populates `sourcesByType` by visiting ROOT
 *     views only; the v1 compiled server passes `roots: {}` (ADR 0016/0019),
 *     leaving its byId plane unreachable dead code. The interpreter resolves
 *     `config.sources` directly — strictly additive on the wire: fate's
 *     client CAN emit `kind: "byId"` (cache-miss node fetches, missing-field
 *     refetches, the live-payload fallback), and v1 served all of those
 *     NOT_FOUND, so the divergence is error→data — live since the v2
 *     cutover (ADR 0043), fixing a latent live-refetch breakage. Pinned
 *     loudly in the oracle suite.
 *   - fate's hidden computed-state stamping (`attachComputedState`, a
 *     module-private symbol) is unreachable for package-authored loaders —
 *     plain rows never carry it — so computed deps derive from the `select`
 *     declaration alone.
 *   - Reference-preservation bookkeeping (fate's `assignIfChanged`) is
 *     skipped: the walk always rebuilds through masking, so identity is
 *     wire-invisible.
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

/** The operation-level args bag the walk threads to view callbacks. */
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

// --- the selection plan (fate's createViewPlan/assignPath) -------------------------

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

// --- view callbacks (fate's promise-shaped resolver/computed functions) ------------

/**
 * fate's `toProtocolError` mask for walk-internal throws: a
 * `FateRequestError` keeps itself; anything else is fate's OWN internal arm.
 * (These errors never pass through `encodeWireError` in fate — see the
 * module doc's taxonomy.)
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
 * fate's `getComputedDeps`, minus the hidden computed-state read (module-doc
 * divergence): `count` selections read `_count.<relation>` (default 0),
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

// --- the walk itself (fate's resolveNode / filterToViewFields / toConnectionResult) -

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
				const items = yield* Effect.forEach(current.items, (entry) =>
					Effect.gen(function* () {
						if (!isRecord(entry)) {
							return entry;
						}
						return {...entry, node: yield* resolveNode(entry.node, relationNode, options)};
					}),
				);
				assign(field, {...current, items});
				continue;
			}
			if (Array.isArray(current)) {
				assign(
					field,
					yield* Effect.forEach(current, (entry) => resolveNode(entry, relationNode, options)),
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
					const items = yield* Effect.forEach(current.items, (entry) =>
						Effect.gen(function* () {
							if (!isRecord(entry)) {
								return entry;
							}
							return {
								...entry,
								node: yield* toConnectionResult(entry.node, config, args, nextPath),
							};
						}),
					);
					assign(field, {...current, items});
					continue;
				}
				if (!Array.isArray(current)) {
					continue;
				}
				const nodes = yield* Effect.forEach(current, (entry) =>
					toConnectionResult(entry, config, args, nextPath),
				);
				assign(field, yield* arrayToConnection(nodes, getScopedArgs(args, nextPath)));
				continue;
			}
			if (Array.isArray(current)) {
				assign(
					field,
					yield* Effect.forEach(current, (entry) =>
						toConnectionResult(entry, config, args, nextPath),
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

// --- the batched source loads (Request.Class + RequestResolver) --------------------

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

// --- the walk surface ---------------------------------------------------------------

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
