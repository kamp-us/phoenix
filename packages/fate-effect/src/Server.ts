/**
 * `FateServer` — the package-owned service tag, `config`, and `layer`.
 *
 * `config` is pure data capture; `layer` validates it and dies on a bad config. The
 * per-request pair (`CurrentUser`/`LivePublisher`) never comes from a worker-level layer —
 * `Provision.ts` provides it onto each handler per request. See ADR 0042/0043, and ADR
 * 0107 §7 for the extra app-registered per-request services.
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
import {FateWireCode, INTERNAL_WIRE_CODE, wireCodeOfClass} from "./WireError.ts";

/**
 * Any `Fate.query` entry, type-erased. `resolve` keeps its CONCRETE raw-wire parameter so
 * the compile step (`Executor.ts`) can call it without recovering the precise entry type.
 */
export interface AnyFateQuery {
	readonly kind: "query";
	readonly definition: QueryDefinition;
	readonly type: string | undefined;
	readonly handler: (input: never) => Effect.Effect<unknown, unknown, unknown>;
	readonly resolve: (input: RawArgsInput) => Effect.Effect<unknown, unknown, unknown>;
}

export interface AnyFateList {
	readonly kind: "list";
	readonly definition: ListDefinition;
	readonly type: string | undefined;
	readonly handler: (input: never) => Effect.Effect<unknown, unknown, unknown>;
	readonly resolve: (
		input: RawArgsInput,
	) => Effect.Effect<ConnectionResult<unknown>, unknown, unknown>;
}

export interface AnyFateMutation {
	readonly kind: "mutation";
	readonly definition: MutationDefinition;
	readonly type: string | undefined;
	readonly handler: (input: never) => Effect.Effect<unknown, unknown, unknown>;
	readonly resolve: (input: RawMutationInput) => Effect.Effect<unknown, unknown, unknown>;
}

export interface DataViewLike {
	readonly typeName: string;
	readonly fields: Record<string, unknown>;
}

export interface SourceDefinitionLike {
	readonly id: string;
	readonly view: DataViewLike;
}

export interface AnyFateSourceHandlers {
	readonly byId?: (id: string) => Effect.Effect<Record<string, unknown> | null, never, unknown>;
	readonly byIds?: (
		ids: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, never, unknown>;
	readonly connection?: (
		page: SourceConnectionInput,
	) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, never, unknown>;
}

export interface AnyFateSourceEntry {
	readonly typeName: string;
	readonly definition: SourceDefinitionLike;
	readonly handlers: AnyFateSourceHandlers;
}

export type FateQueriesRecord = Record<string, AnyFateQuery>;

export type FateListsRecord = Record<string, AnyFateList>;

export type FateMutationsRecord = Record<string, AnyFateMutation>;

/** A capability-less entry — `handlers: {}` — is the registered-but-unfetchable escape hatch. */
export type FateSourcesList = ReadonlyArray<AnyFateSourceEntry>;

export type FateLiveOption =
	| false
	| LiveEventBus
	| {readonly bus: LiveEventBus; readonly maxQueueSize?: number};

/** Shape-valid, not yet content-valid: `FateServer.layer` runs the content checks. */
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

export interface AnyFateServerConfig {
	readonly queries: FateQueriesRecord;
	readonly lists: FateListsRecord;
	readonly mutations: FateMutationsRecord;
	readonly sources: FateSourcesList;
	readonly live: FateLiveOption | undefined;
}

export type FateRecordServices<Ops> = {[K in keyof Ops]: FateOperationServices<Ops[K]>}[keyof Ops];

export type FateConfigServices<C extends AnyFateServerConfig> =
	| FateRecordServices<C["queries"]>
	| FateRecordServices<C["lists"]>
	| FateRecordServices<C["mutations"]>
	| FateSourceServices<C["sources"][number]>;

/** Read off the keys {@link FateServer.layer} takes, so the package never names the app's service. */
export type RequestServiceId<K> = K extends Context.Key<infer Id, infer _S> ? Id : never;

export type RegisteredRequestServices<Keys extends ReadonlyArray<unknown>> = {
	[Index in keyof Keys]: RequestServiceId<Keys[Index]>;
}[number];

/**
 * The layer's R: the config's requirements MINUS the per-request pair
 * (`CurrentUser`/`LivePublisher`, provided per request by `Provision.ts`), and
 * MINUS any extra per-request services the app registered (`PR`, default
 * `never`, ADR 0107 §7) — a handler depending on a registered service is then
 * filled per request, not at `Layer.provide`. A handler needing a service the
 * app neither layers NOR registers stays in R: a build-time compile error, never
 * a silent runtime miss.
 */
export type FateServerRequirements<C extends AnyFateServerConfig, PR = never> = Exclude<
	FateConfigServices<C>,
	CurrentUser | LivePublisher | PR
>;

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
 * Shared by `FateServer.layer` (dies at worker init) and `FateExecutor.toCodegenServer`
 * (throws at build time) so the same mistake reads the same at both edges.
 */
export const collectConfigIssues = (config: AnyFateServerConfig): Array<string> => {
	const issues: Array<string> = [];
	const categories = [
		["queries", config.queries],
		["lists", config.lists],
		["mutations", config.mutations],
	] as const;

	// Only collisions ACROSS the category records are visible here: within one record the
	// spread collapsed duplicate keys before this code could see them.
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

	// fate resolves a view to ONE definition by type name, so a second source for the same
	// entity is a silent override waiting to happen.
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

/**
 * Structural guards throughout: the walk must not assume AST internals beyond what it reads.
 * The AST-drift canary (`Server.unit.test.ts`) fails loudly if effect moves either anchor
 * (`ast.annotations`, union members on `ast.types`).
 */
const collectWireCodes = (ast: unknown, out: Set<string>): void => {
	if (Predicate.hasProperty(ast, "annotations")) {
		const annotations: unknown = ast.annotations;
		if (Predicate.hasProperty(annotations, FateWireCode)) {
			const code: unknown = annotations[FateWireCode];
			if (typeof code === "string") out.add(code);
		}
	}
	// A `Schema.Union([...])` AST carries its members on `types`.
	if (Predicate.hasProperty(ast, "types") && Array.isArray(ast.types)) {
		for (const member of ast.types) collectWireCodes(member, out);
	}
};

/**
 * Every wire code this config can emit: each operation's declared error union plus the two
 * the package always can — {@link INTERNAL_WIRE_CODE} and `InputValidationError`'s code.
 * Sources are excluded by construction (loaders have `E = never`, so no errors to walk).
 * The canonical walker the client-coverage guard consumes (`wireCodes.unit.test.ts`) —
 * exported so no consumer re-rolls the AST walk.
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

export interface FateServerService extends AnyFateServerConfig {
	readonly services: Context.Context<never>;
}

export class FateServer extends Context.Service<FateServer, FateServerService>()(
	"fate-effect/FateServer",
) {
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

	static layer<C extends AnyFateServerConfig>(
		config: C,
	): Layer.Layer<FateServer, never, FateServerRequirements<C>>;
	/**
	 * ADR 0107 §7. The keys are a TYPE-LEVEL witness only — the layer never reads them at
	 * runtime (hence `_requestServices`); the app fills their VALUES via
	 * `FateRequestContext.requestServices`.
	 */
	static layer<
		C extends AnyFateServerConfig,
		const Keys extends ReadonlyArray<Context.Key<unknown, unknown>>,
	>(
		config: C,
		requestServices: Keys,
	): Layer.Layer<FateServer, never, FateServerRequirements<C, RegisteredRequestServices<Keys>>>;
	static layer(
		config: AnyFateServerConfig,
		_requestServices?: ReadonlyArray<Context.Key<unknown, unknown>>,
	): Layer.Layer<FateServer> {
		return Layer.effect(
			FateServer,
			Effect.gen(function* () {
				const issues = collectConfigIssues(config);
				if (issues.length > 0) {
					return yield* Effect.die(new FateServerConfigError(issues));
				}
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
