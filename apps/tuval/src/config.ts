/**
 * The user-owned config's fail-closed module loader and the two-layer merge — a global module
 * under the home dir's `.tuval` and an optional project module under the cwd's `.tuval`, project
 * over global. The shape a module decodes against is the SDK's (`@kampus/tuval-sdk/config`),
 * because a config is written against it outside this app.
 *
 * Configuration is code the user owns (the Neovim model, #7484 R1.1): a TypeScript module whose
 * default export is a `{version: 1, programs, features?, graph?, keys?}` config. Loading refuses on any defect the
 * loader can see — the module throwing, no default export, an export the schema rejects — and
 * every refusal names the module and the reason, so boot never runs on a half-read config. A
 * module that is not there is an empty layer, never a refusal: the layer is optional and the bin
 * refuses an explicitly named path before boot.
 */

import {dirname} from "node:path";
import {TuvalConfig} from "@kampus/tuval-sdk/config";
import {
	type BindingSource,
	type ConfigLayer,
	describeFile,
	type KeyBindings,
} from "@kampus/tuval-sdk/kernel/commands/bindings/index";
// Re-exported below rather than declared here: both ends of the node/browser wire need the resolved
// flag record, and this module reaches `node:*` (#8439).
import {featuresDefault, type TuvalFeatures} from "@kampus/tuval-sdk/kernel/features";
import type {Graph} from "@kampus/tuval-sdk/kernel/ports/graph";
import type {AnyProgram} from "@kampus/tuval-sdk/kernel/registry/program";
import {
	type DeclaredProgram,
	type ModuleRendererRef,
	moduleRendererRefs,
} from "@kampus/tuval-sdk/kernel/shell/window/renderer";
import {Effect, FileSystem, Option, Schema, SchemaIssue} from "effect";
import type {AuthoredModules} from "./authored-modules.ts";
import {generationUrl, nextGeneration, takeGeneration} from "./module-generations.ts";

export {DeclaredFeatures, TuvalConfig} from "@kampus/tuval-sdk/config";
export {featuresDefault, type TuvalFeatures} from "@kampus/tuval-sdk/kernel/features";

export class ConfigLoadError extends Schema.TaggedError<ConfigLoadError>()(
	"tuval/ConfigLoadError",
	{
		module: Schema.String,
		reason: Schema.String,
		/**
		 * Every file the refused load read before it refused, the refusing module among them. A desk
		 * watches these after a refusal, so fixing a file only the refused config imports reloads it.
		 */
		files: Schema.Array(Schema.String),
	},
) {
	override get message(): string {
		return `config module ${this.module}: ${this.reason}`;
	}
}

const thrownMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({
	leafHook: SchemaIssue.defaultLeafHook,
	checkHook: SchemaIssue.defaultCheckHook,
});

const renderPath = (path: ReadonlyArray<PropertyKey | {readonly key: PropertyKey}>): string =>
	path
		.map((segment) => (typeof segment === "object" ? segment.key : segment))
		.map((key, index) =>
			typeof key === "number" ? `[${key}]` : index === 0 ? String(key) : `.${String(key)}`,
		)
		.join("");

const describeIssue = (error: Schema.SchemaError): string => {
	const [first] = formatIssues(error.issue).issues;
	if (first === undefined) return "not a v1 config";
	const at =
		first.path === undefined || first.path.length === 0 ? "" : ` at ${renderPath(first.path)}`;
	return `not a v1 config${at}: ${first.message}`;
};

const decodeConfig = Schema.decodeUnknownEffect(TuvalConfig);

export const loadConfigModule = Effect.fn("Tuval.loadConfigModule")(function* (
	modulePath: string,
	load: number = nextGeneration(),
) {
	// Only the module itself: what it imports is recorded per load, which `loadLayeredConfig` owns.
	const refuse = (reason: string) =>
		new ConfigLoadError({module: modulePath, reason, files: [modulePath]});
	const loaded = yield* Effect.tryPromise({
		try: (): Promise<Record<string, unknown>> => import(generationUrl(modulePath, load)),
		catch: (cause) => refuse(`module threw while loading: ${thrownMessage(cause)}`),
	});
	if (!("default" in loaded)) {
		return yield* refuse(
			"no default export; export default a {version: 1, programs: [...]} config",
		);
	}
	return yield* decodeConfig(loaded.default).pipe(
		Effect.mapError((error) => refuse(describeIssue(error))),
	);
});

export interface ConfigLayers {
	/** The global module: `<home>/.tuval/tuval.config.ts` unless the bin's `--config` names one. */
	readonly global: string;
	/** The project module: `<project>/.tuval/tuval.config.ts`. */
	readonly project: string;
	/**
	 * The layer read in the project module's place while that module is absent, merged under the
	 * global layer so a global row with the same id still wins. Absent means an absent project
	 * module is an empty layer.
	 */
	readonly projectDefault?: TuvalConfig;
}

export interface LoadedConfig {
	readonly programs: ReadonlyArray<unknown>;
	/** The merged flags, project over global — one flag at a time, not one block replacing another. */
	readonly features: TuvalFeatures;
	/**
	 * The `kind: "module"` window specifiers the merged rows declared, each beside the layer module
	 * that declared it. Carried from here rather than recomputed from `programs`, because the origin
	 * is only knowable while the layers are still apart — a flat merged row has lost its layer (#8262).
	 */
	readonly moduleRenderers: ReadonlyArray<ModuleRendererRef>;
	readonly graph: Graph;
	/**
	 * One binding source per layer that existed, global first. They stay apart rather than merging
	 * into one record so a binding error names the module its author wrote it in; a later layer's
	 * binding for a key a lower layer also bound wins, because a key router reads the list in order.
	 */
	readonly keys: ReadonlyArray<BindingSource>;
	/** The layer modules that existed and were merged, global first. */
	readonly sources: ReadonlyArray<string>;
	/** Whether `ConfigLayers.projectDefault` stood in for an absent project module on this load. */
	readonly projectDefaulted: boolean;
	/**
	 * Every file this load read the config from: the layer modules in `sources`, and each file they
	 * import by path, transitively (`./module-generations.ts`). Packages are not in it.
	 */
	readonly files: ReadonlyArray<string>;
	/** The source this load compiled each of `files` from, and what each imports by path. */
	readonly modules: AuthoredModules;
}

/**
 * A config module sits at `<base>/.tuval/tuval.config.ts`, so its base is two directories up and
 * an error names it `global .tuval/tuval.config.ts`. A module somewhere else falls back to its bare
 * file name inside `describeFile`, which is the rule keeping a machine's directory layout out of a
 * line people paste into issues.
 */
const bindingSource = (layer: ConfigLayer, path: string, keys: KeyBindings): BindingSource => ({
	file: describeFile({layer, path, base: dirname(dirname(path))}),
	bindings: keys,
});

const rowId = (row: unknown): string => (row as {readonly id: string}).id;

/**
 * A layer's rows, each stamped with the module they were written in. Config rows are trusted local
 * code and opaque past their id (#7484 R1.1), so the cast here is the same one `boot` makes.
 */
const declaredIn = (config: TuvalConfig, module: string): ReadonlyArray<DeclaredProgram> =>
	config.programs.map((row) => ({row: row as AnyProgram, origin: module}));

/** `over` replaces a `base` entry with the same key in place; the rest append in `over`'s order. */
const mergeById = <T>(base: ReadonlyArray<T>, over: ReadonlyArray<T>, key: (item: T) => string) => {
	const overrides = new Map(over.map((item) => [key(item), item] as const));
	const merged = base.map((item) => overrides.get(key(item)) ?? item);
	const baseKeys = new Set(base.map(key));
	return [...merged, ...over.filter((item) => !baseKeys.has(key(item)))];
};

const present = Effect.fn("Tuval.present")(function* (modulePath: string) {
	const fs = yield* FileSystem.FileSystem;
	return yield* fs.exists(modulePath).pipe(Effect.orElseSucceed(() => false));
});

const loadOptional = Effect.fn("Tuval.loadOptional")(function* (modulePath: string, load: number) {
	return (yield* present(modulePath))
		? Option.some(yield* loadConfigModule(modulePath, load))
		: Option.none<TuvalConfig>();
});

/**
 * Both layers, absent ones empty, merged project-over-global by program id and node id. An absent
 * project module reads as `layers.projectDefault` when one is given, under the global layer.
 */
export const loadLayeredConfig = Effect.fn("Tuval.loadLayeredConfig")(function* (
	layers: ConfigLayers,
) {
	const load = nextGeneration();
	const [global, project] = yield* Effect.all(
		[loadOptional(layers.global, load), loadOptional(layers.project, load)],
		{concurrency: 1},
	).pipe(
		Effect.catch((error) =>
			Effect.gen(function* () {
				const imported = takeGeneration(load).files;
				// The project layer loads second, so a refusal there read the global one first.
				const global =
					error.module === layers.project && (yield* present(layers.global)) ? [layers.global] : [];
				return yield* new ConfigLoadError({
					module: error.module,
					reason: error.reason,
					files: [...new Set([...global, ...error.files, ...imported])],
				});
			}),
		),
		// A defect or an interrupt still drops the record; the refusal above already took it.
		Effect.onError(() => Effect.sync(() => takeGeneration(load))),
	);
	const {files: imported, modules} = takeGeneration(load);
	const empty: TuvalConfig = {
		version: 1,
		programs: [],
		features: {},
		graph: {nodes: []},
		keys: {},
	};
	const sources = [
		...(Option.isSome(global) ? [layers.global] : []),
		...(Option.isSome(project) ? [layers.project] : []),
	];
	const fallback = Option.isNone(project)
		? Option.fromNullishOr(layers.projectDefault)
		: Option.none();
	const under = Option.getOrElse(fallback, () => empty);
	const base = Option.getOrElse(global, () => empty);
	const over = Option.getOrElse(project, () => empty);
	// Merged as declared rows rather than as bare rows: the merge is the last place a row and its
	// layer module are still together, and a project row that replaces a global one by id has to come
	// out carrying the project module as its origin.
	const declared = mergeById(
		mergeById(declaredIn(under, layers.project), declaredIn(base, layers.global), (program) =>
			rowId(program.row),
		),
		declaredIn(over, layers.project),
		(program) => rowId(program.row),
	);
	return {
		// Widened back: the loader checked each row's id and nothing else, and that is all a caller
		// may assume of one.
		programs: declared.map((program): unknown => program.row),
		features: {...featuresDefault, ...under.features, ...base.features, ...over.features},
		moduleRenderers: moduleRendererRefs(declared),
		graph: {
			nodes: mergeById(
				mergeById(under.graph.nodes, base.graph.nodes, (node) => node.id),
				over.graph.nodes,
				(node) => node.id,
			),
		},
		keys: [
			...(Option.isSome(global) ? [bindingSource("global", layers.global, base.keys)] : []),
			...(Option.isSome(project) ? [bindingSource("project", layers.project, over.keys)] : []),
		],
		sources,
		projectDefaulted: Option.isSome(fallback),
		files: [...new Set([...sources, ...imported])],
		modules,
	} satisfies LoadedConfig;
});
