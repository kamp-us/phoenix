/**
 * `FateServer` — the package-owned service tag, `config`, and `layer`.
 *
 * fate has exactly one composite — the server — so it is the one Effect
 * service (the `HttpRouter` idiom: the package owns the tag, no user-defined
 * class). Composition is ordinary layer
 * algebra:
 *
 *   - **`FateServer.config({queries, lists, mutations, sources, live})`**
 *     mirrors `createFateServer`'s options shape. Record values are
 *     `Fate.query`/`Fate.list`/`Fate.mutation` entries; `sources` is the
 *     package's array of `Fate.source` entries (fate's own `sources` option
 *     is the derived `{getSource, registry}` resolver, which the compile
 *     step builds — the definition objects here are held BY IDENTITY for
 *     fate's identity-keyed registry). Every entry is constructor-built.
 *     `config` is pure data capture: full entry types are preserved on the
 *     value (the codegen surface's `InferFateAPI` fidelity rides on them);
 *     validation happens at layer construction.
 *
 *   - **`FateServer.layer(config)`** returns `Layer<FateServer>` whose R is
 *     the union of handler/source requirements
 *     ({@link FateConfigServices}) MINUS the per-request pair —
 *     `CurrentUser` and `LivePublisher` are the server's documented
 *     per-request contract, provided onto each handler per request by the
 *     provision pipeline (`provideRequestPair`, `Provision.ts` — the
 *     interpreter's serving path since ADR 0043), never by a worker-level
 *     layer
 *     ({@link FateServerRequirements}). Domain layers discharge R with
 *     ordinary `Layer.provide`; a forgotten domain layer is a compile error
 *     at the composition site.
 *
 *   - **Init-time validation**: duplicate wire names across
 *     the category records (both owners named), duplicate sources per
 *     entity, and view-reachable entities without a source (entity + where
 *     it was reached from) fail layer construction with a
 *     {@link FateServerConfigError} defect — composition mistakes are
 *     programmer errors, so they die (E stays `never`) and surface at worker
 *     init in dev, not at request time. Within ONE record, spread collapses
 *     duplicate keys before any code can see them (fate's own
 *     shape) — the check covers collisions ACROSS the
 *     spread category records, exactly what the manifest would otherwise
 *     merge silently.
 *
 * The layer captures the build-time services (`Effect.context()`) into the
 * service value: the per-request provision pipeline (`provideRequestPair`,
 * `Provision.ts`) provides that captured context plus the per-request pair
 * onto each entry's `resolve` — on the request fiber via the interpreter
 * (the serving path since ADR 0043); the compile step applies the same
 * pipeline only as the differential oracle's baseline.
 */
import type {ConnectionResult, LiveEventBus} from "@nkzw/fate/server";
import {Context, Effect, Layer} from "effect";
import * as Predicate from "effect/Predicate";
import type {CurrentUser} from "./CurrentUser.ts";
import type {LivePublisher} from "./LivePublisher.ts";
import type {
	FateOperationServices,
	ListDefinition,
	MutationDefinition,
	QueryDefinition,
	RawArgsInput,
	RawMutationInput,
	TypeRef,
} from "./Operation.ts";
import {InputValidationError} from "./Operation.ts";
import type {FateSourceServices, SourceConnectionInput} from "./Source.ts";
import {ErrorCode, INTERNAL_WIRE_CODE, wireCodeOfClass} from "./WireError.ts";

// --- the erased entry shapes (what the config records may contain) ----------

/**
 * Any `Fate.query` entry, type-erased: the supertype every
 * `FateQuery<D, A, E, R>` is assignable to (handler parameters at `never`,
 * channels at `unknown`). `resolve` keeps its CONCRETE raw-wire parameter
 * ({@link RawArgsInput} / {@link RawMutationInput}) so the compile step
 * (`Executor.ts`) can call it without recovering the precise entry type. The
 * config record constraints and the stored {@link FateServerService} records
 * are typed in these — the precise entry types live on the
 * {@link FateServerConfig} value itself.
 */
export interface AnyFateQuery {
	readonly kind: "query";
	readonly definition: QueryDefinition;
	readonly type: string | undefined;
	readonly handler: (input: never) => Effect.Effect<unknown, unknown, unknown>;
	readonly resolve: (input: RawArgsInput) => Effect.Effect<unknown, unknown, unknown>;
}

/**
 * Any `Fate.list` entry, type-erased (see {@link AnyFateQuery}). The success
 * channel keeps fate's `ConnectionResult` envelope (item type erased) — the
 * compiled fate list resolver promises that shape.
 */
export interface AnyFateList {
	readonly kind: "list";
	readonly definition: ListDefinition;
	readonly type: string | undefined;
	readonly handler: (input: never) => Effect.Effect<unknown, unknown, unknown>;
	readonly resolve: (
		input: RawArgsInput,
	) => Effect.Effect<ConnectionResult<unknown>, unknown, unknown>;
}

/** Any `Fate.mutation` entry, type-erased (see {@link AnyFateQuery}). */
export interface AnyFateMutation {
	readonly kind: "mutation";
	readonly definition: MutationDefinition;
	readonly type: string | undefined;
	readonly handler: (input: never) => Effect.Effect<unknown, unknown, unknown>;
	readonly resolve: (input: RawMutationInput) => Effect.Effect<unknown, unknown, unknown>;
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

/**
 * Any `Fate.source` handlers bag, type-erased. Row types erase to the plain
 * record (`Item` is covariant in the success channel), so the compile step
 * can adapt these to fate's row-typed `SourceExecutor` without recovering
 * the precise source type.
 */
export interface AnyFateSourceHandlers {
	readonly byId?: (id: string) => Effect.Effect<Record<string, unknown> | null, never, unknown>;
	readonly byIds?: (
		ids: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, never, unknown>;
	readonly connection?: (
		page: SourceConnectionInput,
	) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, never, unknown>;
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

// --- the config shape ---------------------------------------------------------

/** What `config.queries` accepts: `Fate.query` entries. */
export type FateQueriesRecord = Record<string, AnyFateQuery>;

/** What `config.lists` accepts: `Fate.list` entries. */
export type FateListsRecord = Record<string, AnyFateList>;

/** What `config.mutations` accepts: `Fate.mutation` entries. */
export type FateMutationsRecord = Record<string, AnyFateMutation>;

/** What `config.sources` accepts: `Fate.source` entries (a capability-less
 * entry — `handlers: {}` — is the registered-but-unfetchable escape hatch). */
export type FateSourcesList = ReadonlyArray<AnyFateSourceEntry>;

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
 * compile step and the codegen surface both read them.
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
 * handler requirements.
 */
export type FateConfigServices<C extends AnyFateServerConfig> =
	| FateRecordServices<C["queries"]>
	| FateRecordServices<C["lists"]>
	| FateRecordServices<C["mutations"]>
	| FateSourceServices<C["sources"][number]>;

/**
 * The layer's R: the config's requirements MINUS the per-request pair. The
 * server itself provides `CurrentUser` and `LivePublisher` to each handler
 * per request (the provision pipeline, `Provision.ts`) — they are the
 * per-request contract, so they never appear at the `Layer.provide`
 * composition site.
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

/**
 * Collect every config problem — all of them at once, names attached. Shared
 * by `FateServer.layer` (dies at worker init) and
 * `FateExecutor.toCodegenServer` (throws at build time): the SAME composition
 * mistakes surface at both edges, with the same wording.
 */
export const collectConfigIssues = (config: AnyFateServerConfig): Array<string> => {
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

	// Typeless mutations: fate's manifest carries every mutation's wire type,
	// so a mutation entry without one is a config error. `Fate.mutation` makes
	// this unrepresentable in typed code (`MutationDefinition` requires
	// `type:`); the check guards the erased shape's wider `string | undefined`
	// — and it lives HERE so the same mistake fails layer construction and
	// both compile surfaces with the same wording.
	for (const [name, entry] of Object.entries(config.mutations)) {
		if (entry.type === undefined) {
			issues.push(`mutation "${name}" carries no wire type`);
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
	// have a source.
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

// --- the declared wire vocabulary -----------------------------------------------

/**
 * Collect every `ErrorCode` annotation reachable from one Schema AST node:
 * the node's own annotation plus (for a union) each member's. Structural
 * guards throughout — the walk must not assume AST internals beyond what it
 * reads (the same defensive shape as `wireCodeOfClass`); the package's
 * AST-drift canary (`Server.unit.test.ts`) fails loudly if effect moves
 * either anchor (`ast.annotations`, union members on `ast.types`).
 */
const collectWireCodes = (ast: unknown, out: Set<string>): void => {
	if (Predicate.hasProperty(ast, "annotations")) {
		const annotations: unknown = ast.annotations;
		if (Predicate.hasProperty(annotations, ErrorCode)) {
			const code: unknown = annotations[ErrorCode];
			if (typeof code === "string") out.add(code);
		}
	}
	// A `Schema.Union([...])` AST carries its members on `types`.
	if (Predicate.hasProperty(ast, "types") && Array.isArray(ast.types)) {
		for (const member of ast.types) collectWireCodes(member, out);
	}
};

/**
 * Every wire code this config can emit through the annotation codec
 * (`encodeWireError`): each operation's DECLARED error union, walked via its
 * Schema AST (annotations land on each class's AST, so the registered config
 * is the single source), plus the two codes the package can always emit
 * independent of any declaration — {@link INTERNAL_WIRE_CODE} for
 * defects/un-annotated failures and `InputValidationError`'s annotated code
 * for Schema rejections.
 *
 * Sources are excluded by construction: loaders have `E = never` (the
 * loader/resolver split), so they declare no errors to walk. fate's own
 * walk-internal arm (`internalArm`: `INTERNAL_ERROR`) is the byId plane's
 * taxonomy, not part of this operation-plane vocabulary.
 *
 * This is the canonical walker a client-coverage guard consumes (the worker's
 * `wireCodes.unit.test.ts`: "the SPA list covers every code the server can
 * emit") — exported so no consumer re-rolls the AST walk against
 * package-private knowledge.
 */
export const declaredWireCodes = (config: AnyFateServerConfig): ReadonlySet<string> => {
	const codes = new Set<string>([INTERNAL_WIRE_CODE]);
	const validationCode = wireCodeOfClass(InputValidationError);
	if (validationCode !== undefined) codes.add(validationCode);
	for (const record of [config.queries, config.lists, config.mutations]) {
		for (const entry of Object.values(record)) {
			const error = entry.definition.error;
			if (error !== undefined) collectWireCodes(error.ast, codes);
		}
	}
	return codes;
};

// --- the service ---------------------------------------------------------------

/**
 * What the `FateServer` service holds: the (validated) config records,
 * type-erased, plus the services captured when the layer was built. The
 * provision pipeline (`Provision.ts`) reads both — it provides `services` +
 * the per-request pair onto each entry's `resolve`, on the request fiber via
 * the interpreter (the serving path) and through the worker ManagedRuntime
 * on the oracle's compile step.
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
	 * `Fate.*` record values. Pure data: entry types are
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
				// Capture the build-time services: the provision pipeline provides
				// them (plus the per-request pair) onto each handler at the fate edge.
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
