/**
 * The shared compiled-definition internals — the common vocabulary of the
 * compile step's two surfaces: the oracle
 * baseline (`Executor.ts`, test-harness-only since ADR 0043) and the
 * build-time codegen server (`Codegen.ts`, the production build path every
 * deploy runs through `schema.ts`). Those two lifecycles must never import
 * each other, so what they share lives here:
 *
 *   - the compiled operation-definition shapes (`CompiledQueryDefinition` /
 *     `CompiledListDefinition` / `CompiledMutationDefinition`) — fate's
 *     definition records as the compile step emits them, executable (live
 *     compile) or inert (codegen);
 *   - the identity-keyed source resolver (`buildSourceResolver` →
 *     `CompiledFateSources`) — ONE registry Map keyed by each entry's
 *     definition object, with the executor half supplied by the caller;
 *   - the kernel-type recoveries those need (`toKernelDefinition`, the
 *     `getSource` Item re-pin) — erased→kernel narrowings; the contained-
 *     boundary story lives in `Executor.ts`'s module doc.
 */
import type {ConnectionResult, SourceDefinition, SourceRegistry} from "@nkzw/fate/server";
import type {FateRequestContext} from "./RequestContext.ts";
import type {FateSourcesList, SourceDefinitionLike} from "./Server.ts";

export type AnyRow = Record<string, unknown>;

/**
 * Map a record's values, keys preserved — the compile surfaces' ONE
 * entries→record loop (shared so `Executor.ts`/`Codegen.ts` never hand-roll
 * their own `Object.entries` builds).
 */
export const mapRecord = <V, R>(
	record: Record<string, V>,
	f: (value: V, name: string) => R,
): Record<string, R> => {
	const out: Record<string, R> = {};
	for (const [name, value] of Object.entries(record)) {
		out[name] = f(value, name);
	}
	return out;
};

/**
 * Re-pin a validated config's invariant for the type system: every mutation
 * carries a wire type — `collectConfigIssues` rejects a typeless one before
 * either compile surface runs (`FateServer.layer` dies, `toCodegenServer`
 * throws; the check lives there, the ONE wording site), so the
 * erased `string | undefined` narrows here. The residual throw is an
 * invariant DEFECT (a caller bypassed validation), not config validation —
 * config errors have exactly one home.
 */
export const mutationWireType = (
	name: string,
	entry: {readonly type: string | undefined},
): string => {
	const {type} = entry;
	if (type === undefined) {
		throw new Error(
			`unvalidated config reached the compile step: mutation "${name}" carries no wire type (collectConfigIssues rejects this)`,
		);
	}
	return type;
};

/** The resolver argument bag fate hands a compiled operation. */
export interface CompiledResolverOptions<Input> {
	readonly ctx: FateRequestContext;
	readonly input: Input;
	readonly select: Array<string>;
}

/** fate's wire args bag for queries/lists (`args` may be absent). */
export interface CompiledArgsInput {
	readonly args?: AnyRow | undefined;
}

/** A compiled fate query definition. */
export interface CompiledQueryDefinition {
	readonly type?: string;
	readonly resolve: (options: CompiledResolverOptions<CompiledArgsInput>) => Promise<unknown>;
}

/** As {@link CompiledQueryDefinition}, promising fate's connection envelope. */
export interface CompiledListDefinition {
	readonly type?: string;
	readonly defaultSize?: number;
	readonly resolve: (
		options: CompiledResolverOptions<CompiledArgsInput>,
	) => Promise<ConnectionResult<unknown>>;
}

/**
 * A compiled fate mutation definition. fate's `input?: SchemaLike` slot is
 * deliberately NOT populated — the decode already lives in the entry's
 * `resolve` (a second validator would double-validate).
 */
export interface CompiledMutationDefinition {
	readonly type: string;
	readonly resolve: (options: CompiledResolverOptions<unknown>) => Promise<unknown>;
}

export type KernelSourceDefinition = SourceDefinition<AnyRow, unknown>;

/**
 * fate's `SourceExecutor` is the value half of `SourceRegistry<Context>`;
 * `@nkzw/fate/server` does not export the type by name, so it is recovered
 * from the exported Map type (the bridge's own recovery).
 */
export type KernelSourceExecutor =
	SourceRegistry<FateRequestContext> extends Map<unknown, infer V> ? V : never;

// erased→kernel: the definition object IS the kernel `SourceDefinition` the
// entry was built with (`Fate.source` creates it once — fate's registry keys
// on that identity). The portable `SourceDefinitionLike` exists only because
// fate's `DataView` would trip TS2883 in exported config types.
export const toKernelDefinition = (definition: SourceDefinitionLike): KernelSourceDefinition =>
	definition as KernelSourceDefinition;

/**
 * The compiled `sources` option — fate's `{getSource, registry}` resolver
 * surface through portable names (`SourceResolver` is not exported by name;
 * `DataView` is reachable as `SourceDefinition["view"]`).
 */
export interface CompiledFateSources {
	readonly getSource: <Item extends AnyRow>(
		target: SourceDefinition<Item, unknown>["view"] | SourceDefinition<Item, unknown>,
	) => SourceDefinition<Item, unknown>;
	readonly registry: SourceRegistry<FateRequestContext>;
}

/**
 * Build fate's `{getSource, registry}` from the config's source entries: ONE
 * registry Map keyed by each entry's definition object (the SAME object —
 * fate looks executors up by identity); `getSource` resolves a view or
 * definition by `typeName` to the same keyed object. The executor half is
 * caller-supplied: live compilation (`Executor.ts`) adapts the entry's
 * Effect handlers, the codegen path (`Codegen.ts`) installs empty (inert)
 * ones.
 */
export const buildSourceResolver = (
	sources: FateSourcesList,
	executorFor: (entry: FateSourcesList[number]) => KernelSourceExecutor,
): CompiledFateSources => {
	const registry: SourceRegistry<FateRequestContext> = new Map();
	const byType = new Map<string, KernelSourceDefinition>();
	for (const entry of sources) {
		const definition = toKernelDefinition(entry.definition);
		byType.set(definition.view.typeName, definition);
		registry.set(definition, executorFor(entry));
	}
	const getSource = <Item extends AnyRow>(
		target: SourceDefinition<Item, unknown>["view"] | SourceDefinition<Item, unknown>,
	): SourceDefinition<Item, unknown> => {
		// fate calls getSource with a base or list()-wrapped view OR a
		// definition; all carry `typeName`, so resolve by it.
		const typeName = "view" in target ? target.view.typeName : target.typeName;
		const definition = byType.get(typeName);
		if (definition === undefined) {
			throw new Error(`No source registered for '${typeName}'.`);
		}
		// erased→kernel: the Map stores row-erased definitions; fate's generic
		// getSource contract re-pins the caller's `Item` (the bridge's exact
		// narrowing in its hand-built sources resolver).
		return definition as SourceDefinition<Item, unknown>;
	};
	return {getSource, registry};
};
