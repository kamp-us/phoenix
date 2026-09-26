/**
 * The user-owned config's fail-closed module loader and the three-layer merge — the desk's own
 * layer, then a global module under the home dir's `.tuval`, then an optional project module under
 * the cwd's `.tuval`. The desk layer is code, not a file: it carries the rows and graph nodes the
 * desk supplies itself (its shell, #9683), and a file layer that declares one of their ids is
 * refused rather than merged. The project layer's rows and nodes run under its project's scope
 * (`./config-scope.ts`, #9684), so no layer replaces another's row. The shape a module decodes against is the SDK's
 * (`@kampus/tuval-sdk/config`), because a config is written against it outside this app.
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
import {Effect, FileSystem, Option, Result, Schema, SchemaIssue} from "effect";
import {globalLayer, projectLayer, reservedSeparator} from "./config-scope.ts";
import {generationUrl, nextGeneration, takeGenerationFiles} from "./module-generations.ts";
import type {ProjectId} from "./project-id.ts";

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

/**
 * The rows and graph nodes the desk supplies itself, below every config file. No file layer may
 * declare one of their ids: a stale config still carrying the shell row would otherwise run a second
 * shell beside the desk's own.
 */
export interface DeskLayer {
	/** The module that built these rows, which is where a desk row's module renderer resolves from. */
	readonly origin: string;
	readonly programs: ReadonlyArray<AnyProgram>;
	readonly graph: Graph;
}

export interface ConfigLayers {
	/** The desk's own layer, read first. */
	readonly desk: DeskLayer;
	/** The global module: `<home>/.tuval/tuval.config.ts` unless the bin's `--config` names one. */
	readonly global: string;
	readonly project: ProjectLayer;
}

export interface ProjectLayer {
	/** The project whose scope this layer's rows and graph nodes run under. */
	readonly id: ProjectId;
	/** The project module: `<project>/.tuval/tuval.config.ts`. */
	readonly module: string;
}

export interface LoadedConfig {
	/** The desk's rows, then the global layer's, then the project layer's under its project's scope. */
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
	/**
	 * Every file this load read the config from: the layer modules in `sources`, and each file they
	 * import by path, transitively (`./module-generations.ts`). Packages are not in it.
	 */
	readonly files: ReadonlyArray<string>;
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

const present = Effect.fn("Tuval.present")(function* (modulePath: string) {
	const fs = yield* FileSystem.FileSystem;
	return yield* fs.exists(modulePath).pipe(Effect.orElseSucceed(() => false));
});

/** Why a file layer may not stand over the desk: the first desk row or node id it redeclares. */
const deskConflict = (desk: DeskLayer, config: TuvalConfig): Option.Option<string> => {
	const rows = new Set<string>(desk.programs.map(rowId));
	const nodes = new Set<string>(desk.graph.nodes.map((node) => node.id));
	const row = config.programs.map(rowId).find((id) => rows.has(id));
	if (row !== undefined) {
		return Option.some(
			`declares program row "${row}", which the desk supplies itself; remove the row and its graph node`,
		);
	}
	const node = config.graph.nodes.find((candidate) => nodes.has(candidate.id));
	return node === undefined
		? Option.none()
		: Option.some(
				`declares graph node "${node.id}", which the desk supplies itself; remove the node`,
			);
};

/** A loaded layer as it runs, or why it may not run: one of `./config-scope.ts`'s checks. */
type LayerCheck = (config: TuvalConfig) => Result.Result<TuvalConfig, string>;

const loadOptional = Effect.fn("Tuval.loadOptional")(function* (
	modulePath: string,
	load: number,
	desk: DeskLayer,
	check: LayerCheck,
) {
	if (!(yield* present(modulePath))) return Option.none<TuvalConfig>();
	const config = yield* loadConfigModule(modulePath, load);
	const refuse = (reason: string) =>
		new ConfigLoadError({module: modulePath, reason, files: [modulePath]});
	const conflict = deskConflict(desk, config);
	if (Option.isSome(conflict)) return yield* refuse(conflict.value);
	const checked = Result.flatMap(reservedSeparator(config), check);
	if (Result.isFailure(checked)) return yield* refuse(checked.failure);
	return Option.some(checked.success);
});

/**
 * The desk layer, then both file layers, absent ones empty. The desk's rows and nodes come first and
 * no file may redeclare them; the global layer's follow, then the project layer's under its
 * project's scope, and none replaces another.
 */
export const loadLayeredConfig = Effect.fn("Tuval.loadLayeredConfig")(function* (
	layers: ConfigLayers,
) {
	const load = nextGeneration();
	const [global, project] = yield* Effect.all(
		[
			loadOptional(layers.global, load, layers.desk, globalLayer),
			loadOptional(layers.project.module, load, layers.desk, (config) =>
				projectLayer(layers.project.id, config),
			),
		],
		{concurrency: 1},
	).pipe(
		Effect.catch((error) =>
			Effect.gen(function* () {
				const imported = takeGenerationFiles(load);
				// The project layer loads second, so a refusal there read the global one first.
				const global =
					error.module === layers.project.module && (yield* present(layers.global))
						? [layers.global]
						: [];
				return yield* new ConfigLoadError({
					module: error.module,
					reason: error.reason,
					files: [...new Set([...global, ...error.files, ...imported])],
				});
			}),
		),
		// A defect or an interrupt still drops the record; the refusal above already took it.
		Effect.onError(() => Effect.sync(() => takeGenerationFiles(load))),
	);
	const imported = takeGenerationFiles(load);
	const empty: TuvalConfig = {
		version: 1,
		programs: [],
		features: {},
		graph: {nodes: []},
		keys: {},
	};
	const sources = [
		...(Option.isSome(global) ? [layers.global] : []),
		...(Option.isSome(project) ? [layers.project.module] : []),
	];
	const base = Option.getOrElse(global, () => empty);
	const over = Option.getOrElse(project, () => empty);
	// Merged as declared rows rather than as bare rows: the merge is the last place a row and its
	// layer module are still together, and a module renderer resolves from the module that declared it.
	const declared = [
		...layers.desk.programs.map((row) => ({row, origin: layers.desk.origin})),
		...declaredIn(base, layers.global),
		...declaredIn(over, layers.project.module),
	];
	return {
		// Widened back: the loader checked each row's id and nothing else, and that is all a caller
		// may assume of one.
		programs: declared.map((program): unknown => program.row),
		features: {...featuresDefault, ...base.features, ...over.features},
		moduleRenderers: moduleRendererRefs(declared),
		graph: {
			nodes: [...layers.desk.graph.nodes, ...base.graph.nodes, ...over.graph.nodes],
		},
		keys: [
			...(Option.isSome(global) ? [bindingSource("global", layers.global, base.keys)] : []),
			...(Option.isSome(project)
				? [bindingSource("project", layers.project.module, over.keys)]
				: []),
		],
		sources,
		files: [...new Set([...sources, ...imported])],
	} satisfies LoadedConfig;
});
