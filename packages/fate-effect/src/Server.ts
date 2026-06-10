/**
 * `FateServer` — the package-owned service tag, `config`, and `layer`.
 *
 * fate has exactly one composite — the server — so it is the one Effect
 * service (the `HttpRouter` idiom: the package owns the tag, no user-defined
 * class; PRD "The server is the one service"). Composition is ordinary layer
 * algebra:
 *
 *   - **`FateServer.config({queries, lists, mutations, sources, live})`**
 *     mirrors `createFateServer`'s options shape. Record values are
 *     `Fate.query`/`Fate.list`/`Fate.mutation` entries OR raw legacy
 *     bridge-shaped fate records ({@link RawFateOperation} — migration
 *     coexistence is literally spreading the bridge's remaining records into
 *     the same config, PRD story 12). `sources` is the package's array of
 *     `Fate.source` entries / legacy `{definition, executor}` pairs (fate's
 *     own `sources` option is the derived `{getSource, registry}` resolver,
 *     which the compile step builds in task 7 — the definition objects here
 *     are held BY IDENTITY for fate's identity-keyed registry). `config` is
 *     pure data capture: full entry types are preserved on the value (task
 *     8's `InferFateAPI` fidelity rides on them); validation happens at
 *     layer construction.
 *
 *   - **`FateServer.layer(config)`** returns `Layer<FateServer>` whose R is
 *     the union of handler/source requirements
 *     ({@link FateConfigServices}) MINUS the per-request pair —
 *     `CurrentUser` and `LivePublisher` are the server's documented
 *     per-request contract, provided onto each handler per request by the
 *     compile step, never by a worker-level layer
 *     ({@link FateServerRequirements}). Domain layers discharge R with
 *     ordinary `Layer.provide`; a forgotten domain layer is a compile error
 *     at the composition site (PRD story 7).
 *
 *   - **Init-time validation** (PRD story 10): duplicate wire names across
 *     the category records (both owners named), duplicate sources per
 *     entity, and view-reachable entities without a source (entity + where
 *     it was reached from) fail layer construction with a
 *     {@link FateServerConfigError} defect — composition mistakes are
 *     programmer errors, so they die (E stays `never`) and surface at worker
 *     init in dev, not at request time. Within ONE record, spread collapses
 *     duplicate keys before any code can see them (fate's own shape; the
 *     PRD's recorded open question) — the check covers collisions ACROSS the
 *     spread category records, exactly what the manifest would otherwise
 *     merge silently.
 *
 * The layer captures the build-time services (`Effect.context()`) into the
 * service value: task 7's compiler provides that captured context plus the
 * per-request pair onto each entry's `resolve` and runs it through the one
 * worker-level ManagedRuntime (effect-smol `LLMS.md` § "Integrating Effect
 * into existing applications").
 */
import type {LiveEventBus} from "@nkzw/fate/server";
import {Context, Effect, Layer} from "effect";
import type {CurrentUser} from "./CurrentUser.ts";
import type {LivePublisher} from "./LivePublisher.ts";
import type {
	FateOperationServices,
	ListDefinition,
	MutationDefinition,
	QueryDefinition,
	TypeRef,
} from "./Operation.ts";
import type {FateSourceServices, SourceConnectionInput} from "./Source.ts";

// --- the erased entry shapes (what the config records may contain) ----------

/**
 * Any `Fate.query` entry, type-erased: the supertype every
 * `FateQuery<D, A, E, R>` is assignable to (parameters at `never`, channels
 * at `unknown`). The config record constraints and the stored
 * {@link FateServerService} records are typed in these — the precise entry
 * types live on the {@link FateServerConfig} value itself.
 */
export interface AnyFateQuery {
	readonly kind: "query";
	readonly definition: QueryDefinition;
	readonly type: string | undefined;
	readonly handler: (input: never) => Effect.Effect<unknown, unknown, unknown>;
	readonly resolve: (input: never) => Effect.Effect<unknown, unknown, unknown>;
}

/** Any `Fate.list` entry, type-erased (see {@link AnyFateQuery}). */
export interface AnyFateList {
	readonly kind: "list";
	readonly definition: ListDefinition;
	readonly type: string | undefined;
	readonly handler: (input: never) => Effect.Effect<unknown, unknown, unknown>;
	readonly resolve: (input: never) => Effect.Effect<unknown, unknown, unknown>;
}

/** Any `Fate.mutation` entry, type-erased (see {@link AnyFateQuery}). */
export interface AnyFateMutation {
	readonly kind: "mutation";
	readonly definition: MutationDefinition;
	readonly type: string | undefined;
	readonly handler: (input: never) => Effect.Effect<unknown, unknown, unknown>;
	readonly resolve: (input: never) => Effect.Effect<unknown, unknown, unknown>;
}

/**
 * A raw legacy fate record entry — the bridge's promise-shaped resolvers
 * (`{resolve, type?, input?, defaultSize?}`), passing through to
 * `createFateServer` untouched (task 7) with the same FateContext-compatible
 * ctx they receive today. `kind?: undefined` is the discriminant AND a
 * guard: a `Fate.*` entry (which carries `kind`) cannot pose as a raw entry
 * in the wrong record — a mutation dropped into `queries` is a compile
 * error, not a silently miscategorized resolver.
 */
export interface RawFateOperation {
	readonly kind?: undefined;
	readonly resolve: (options: never) => unknown;
	readonly type?: string;
	readonly input?: unknown;
	readonly defaultSize?: number;
}

/**
 * The structural shape of a runtime data view this module can walk for the
 * source-completeness check: fate's `DataView` carries plain `typeName` +
 * `fields`, and nested relation views appear as field values of the same
 * shape (fate's own `isDataViewField` checks `"fields" in field`).
 */
export interface DataViewLike {
	readonly typeName: string;
	readonly fields: Record<string, unknown>;
}

/** A kernel `SourceDefinition` through portable names (id field + view). */
export interface SourceDefinitionLike {
	readonly id: string;
	readonly view: DataViewLike;
}

/** Any `Fate.source` handlers bag, type-erased. */
export interface AnyFateSourceHandlers {
	readonly byId?: (id: string) => Effect.Effect<unknown, never, unknown>;
	readonly byIds?: (ids: ReadonlyArray<string>) => Effect.Effect<unknown, never, unknown>;
	readonly connection?: (page: SourceConnectionInput) => Effect.Effect<unknown, never, unknown>;
}

/**
 * Any `Fate.source` entry, type-erased: the supertype every
 * `FateSource<Item, Name, R>` is assignable to.
 */
export interface AnyFateSourceEntry {
	readonly typeName: string;
	readonly definition: SourceDefinitionLike;
	readonly handlers: AnyFateSourceHandlers;
}

/**
 * A raw legacy source — the bridge's `[SourceDefinition, SourceExecutor]`
 * registry pair as one entry. The `definition` is the SAME object the
 * legacy feature exports (identity matters: fate's registry is keyed by the
 * definition object); the `executor` is the bridge's promise-shaped
 * `SourceExecutor`, passed through untouched by the compile step.
 *
 * Annotate legacy entries with this type at the declaration site: a raw
 * kernel `dataView()` value inside an exported config would otherwise
 * surface fate's non-exported symbol key in the config's inferred type
 * (TS2883 — see `DataView.ts`).
 */
export interface RawFateSourceEntry {
	readonly handlers?: undefined;
	readonly definition: SourceDefinitionLike;
	readonly executor: object;
}

// --- the config shape ---------------------------------------------------------

/** What `config.queries` accepts: `Fate.query` entries or raw legacy records. */
export type FateQueriesRecord = Record<string, AnyFateQuery | RawFateOperation>;

/** What `config.lists` accepts: `Fate.list` entries or raw legacy records. */
export type FateListsRecord = Record<string, AnyFateList | RawFateOperation>;

/** What `config.mutations` accepts: `Fate.mutation` entries or raw legacy records. */
export type FateMutationsRecord = Record<string, AnyFateMutation | RawFateOperation>;

/** What `config.sources` accepts: `Fate.source` entries or legacy pairs. */
export type FateSourcesList = ReadonlyArray<AnyFateSourceEntry | RawFateSourceEntry>;

/**
 * What `config.live` accepts — fate's `live` option through portable names:
 * a `LiveEventBus` (phoenix's publish-only bus), the `{bus, maxQueueSize}`
 * form, or `false`. Passed through to `createFateServer` unchanged.
 */
export type FateLiveOption =
	| false
	| LiveEventBus
	| {readonly bus: LiveEventBus; readonly maxQueueSize?: number};

/**
 * A validated-shape (not yet validated-content) `FateServer` config: the
 * value `FateServer.config` returns, with full entry types preserved — the
 * compile step (task 7) and the codegen spike (task 8) both read them.
 */
export interface FateServerConfig<
	Q extends FateQueriesRecord,
	L extends FateListsRecord,
	M extends FateMutationsRecord,
	S extends FateSourcesList,
> {
	readonly queries: Q;
	readonly lists: L;
	readonly mutations: M;
	readonly sources: S;
	readonly live: FateLiveOption | undefined;
}

/** Any config, type-erased — the bound `FateServer.layer` accepts. */
export interface AnyFateServerConfig {
	readonly queries: FateQueriesRecord;
	readonly lists: FateListsRecord;
	readonly mutations: FateMutationsRecord;
	readonly sources: FateSourcesList;
	readonly live: FateLiveOption | undefined;
}

// --- the R-channel math ---------------------------------------------------------

/** The union of `FateOperationServices` across one record's entries. */
export type FateRecordServices<Ops> = {[K in keyof Ops]: FateOperationServices<Ops[K]>}[keyof Ops];

/**
 * Everything a config requires: handler requirements (including Schema
 * decoding services) across the three operation records, plus source
 * handler requirements. Raw legacy entries contribute `never`.
 */
export type FateConfigServices<C extends AnyFateServerConfig> =
	| FateRecordServices<C["queries"]>
	| FateRecordServices<C["lists"]>
	| FateRecordServices<C["mutations"]>
	| FateSourceServices<C["sources"][number]>;

/**
 * The layer's R: the config's requirements MINUS the per-request pair. The
 * server itself provides `CurrentUser` and `LivePublisher` to each handler
 * per request (the compile step, task 7) — they are the per-request
 * contract, so they never appear at the `Layer.provide` composition site.
 */
export type FateServerRequirements<C extends AnyFateServerConfig> = Exclude<
	FateConfigServices<C>,
	CurrentUser | LivePublisher
>;

// --- init-time validation -------------------------------------------------------

/**
 * An invalid `FateServer` config, raised as a DEFECT at layer construction:
 * duplicate wire names, duplicate sources, or view-reachable entities
 * without a source — programmer errors with names attached, surfacing at
 * worker init in dev, not at request time. Not wire-bound (never crosses
 * the fate boundary), hence a plain `Error`, not an annotated wire error.
 */
export class FateServerConfigError extends Error {
	override readonly name = "FateServerConfigError";
	readonly issues: ReadonlyArray<string>;

	constructor(issues: ReadonlyArray<string>) {
		super(`Invalid FateServer config:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
		this.issues = issues;
	}
}

/** Runtime view detection — mirrors fate's own `isDataViewField` check. */
const isDataViewLike = (value: unknown): value is DataViewLike =>
	typeof value === "object" &&
	value !== null &&
	"typeName" in value &&
	typeof value.typeName === "string" &&
	"fields" in value &&
	typeof value.fields === "object" &&
	value.fields !== null;

/**
 * The walkable view behind a definition's `type`, if any: a `FateDataView`
 * class carries the kernel view at `.view`; a wire type-name string (the
 * `Health` case) has no view by design and never requires a source.
 */
const viewOfTypeRef = (ref: TypeRef | undefined): DataViewLike | undefined => {
	// NOTE: a `FateDataView` class is a FUNCTION at runtime — only the wire
	// type-name string is excluded here, not non-objects.
	if (ref === undefined || typeof ref === "string" || !("view" in ref)) {
		return undefined;
	}
	return isDataViewLike(ref.view) ? ref.view : undefined;
};

/** Collect every config problem — all of them at once, names attached. */
const collectConfigIssues = (config: AnyFateServerConfig): Array<string> => {
	const issues: Array<string> = [];
	const categories = [
		["queries", config.queries],
		["lists", config.lists],
		["mutations", config.mutations],
	] as const;

	// Duplicate wire names across the spread category records. (Within one
	// record the spread already collapsed duplicates — fate's own shape.)
	const owners = new Map<string, Array<string>>();
	for (const [category, record] of categories) {
		for (const name of Object.keys(record)) {
			const list = owners.get(name) ?? [];
			list.push(`${category}["${name}"]`);
			owners.set(name, list);
		}
	}
	for (const [name, where] of owners) {
		if (where.length > 1) {
			issues.push(`duplicate wire name "${name}" — declared by ${where.join(" and ")}`);
		}
	}

	// Duplicate sources per entity: fate resolves a view to ONE definition by
	// type name, so a second source for the same entity is a silent override
	// waiting to happen.
	const sourceCounts = new Map<string, number>();
	for (const entry of config.sources) {
		const name = entry.definition.view.typeName;
		sourceCounts.set(name, (sourceCounts.get(name) ?? 0) + 1);
	}
	for (const [name, count] of sourceCounts) {
		if (count > 1) {
			issues.push(`duplicate source for entity "${name}" (${count} entries)`);
		}
	}

	// Source completeness: every entity reachable through a view object —
	// operation success views and nested relation views, recursively — must
	// have a source. Raw legacy operations carry only a wire type string
	// (nothing to walk); their entities are covered by the legacy sources
	// spread into the same config.
	const reachable = new Map<string, string>();
	const walk = (view: DataViewLike, origin: string): void => {
		if (reachable.has(view.typeName)) {
			return;
		}
		reachable.set(view.typeName, origin);
		for (const field of Object.values(view.fields)) {
			if (isDataViewLike(field)) {
				walk(field, origin);
			}
		}
	};
	for (const [category, record] of categories) {
		for (const [name, entry] of Object.entries(record)) {
			if (entry.kind === undefined) {
				continue;
			}
			const view = viewOfTypeRef(entry.definition.type);
			if (view !== undefined) {
				walk(view, `${category}["${name}"]`);
			}
		}
	}
	for (const entry of config.sources) {
		walk(entry.definition.view, `source "${entry.definition.view.typeName}"`);
	}
	for (const [typeName, origin] of reachable) {
		if (!sourceCounts.has(typeName)) {
			issues.push(`view-reachable entity "${typeName}" has no source (reached from ${origin})`);
		}
	}

	return issues;
};

// --- the service ---------------------------------------------------------------

/**
 * What the `FateServer` service holds: the (validated) config records,
 * type-erased, plus the services captured when the layer was built. The
 * compile step (task 7) reads both — it adapts each entry's `resolve` to a
 * fate resolver by providing `services` + the per-request pair and running
 * through the worker ManagedRuntime.
 */
export interface FateServerService extends AnyFateServerConfig {
	readonly services: Context.Context<never>;
}

/**
 * The fate server as the one Effect service (package-owned tag — the
 * `HttpRouter` idiom). Use the statics: `FateServer.config(...)` to declare,
 * `FateServer.layer(config)` to compose.
 */
export class FateServer extends Context.Service<FateServer, FateServerService>()(
	"fate-effect/FateServer",
) {
	/**
	 * Capture a server config — `createFateServer`'s options shape with
	 * `Fate.*` (or raw legacy) record values. Pure data: entry types are
	 * preserved on the value; validation runs in {@link FateServer.layer}.
	 */
	static config<
		Q extends FateQueriesRecord = Record<never, never>,
		L extends FateListsRecord = Record<never, never>,
		M extends FateMutationsRecord = Record<never, never>,
		S extends FateSourcesList = ReadonlyArray<never>,
	>(options: {
		readonly queries?: Q;
		readonly lists?: L;
		readonly mutations?: M;
		readonly sources?: S;
		readonly live?: FateLiveOption;
	}): FateServerConfig<Q, L, M, S>;
	static config(options: {
		readonly queries?: FateQueriesRecord;
		readonly lists?: FateListsRecord;
		readonly mutations?: FateMutationsRecord;
		readonly sources?: FateSourcesList;
		readonly live?: FateLiveOption;
	}): AnyFateServerConfig {
		return {
			queries: options.queries ?? {},
			lists: options.lists ?? {},
			mutations: options.mutations ?? {},
			sources: options.sources ?? [],
			live: options.live,
		};
	}

	/**
	 * Build the server layer from a config. R is
	 * {@link FateServerRequirements}: handler/source requirements minus the
	 * per-request pair — discharge it with ordinary `Layer.provide`. Invalid
	 * configs (duplicate wire names, missing sources) DIE here with a
	 * {@link FateServerConfigError} naming the offenders.
	 */
	static layer<C extends AnyFateServerConfig>(
		config: C,
	): Layer.Layer<FateServer, never, FateServerRequirements<C>>;
	static layer(config: AnyFateServerConfig): Layer.Layer<FateServer> {
		return Layer.effect(
			FateServer,
			Effect.gen(function* () {
				const issues = collectConfigIssues(config);
				if (issues.length > 0) {
					return yield* Effect.die(new FateServerConfigError(issues));
				}
				// Capture the build-time services: the compile step provides them
				// (plus the per-request pair) onto each handler at the fate edge.
				const services = yield* Effect.context();
				return {
					queries: config.queries,
					lists: config.lists,
					mutations: config.mutations,
					sources: config.sources,
					live: config.live,
					services,
				};
			}),
		);
	}
}
