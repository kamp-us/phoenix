/**
 * The user-owned config's fail-closed module loader and the layered merge — the desk's own layer,
 * then a global module under the home dir's `.tuval`, then an optional module under each open
 * project's `.tuval` (#9685). The desk layer is code, not a file: it carries the rows and graph nodes the
 * desk supplies itself (its shell, #9683), and a file layer that declares one of their ids is
 * refused rather than merged. The project layer's rows and nodes run under its project's scope
 * (`./config-scope.ts`, #9684), so no layer replaces another's row. A row whose SDK range excludes
 * the desk's SDK is refused on its own and the rest of its layer runs (`./sdk-admission.ts`, #9686).
 * Flags and the desk's reserved keys are global only (#9687): a project layer that states a flag or
 * binds a reserved key is refused, and a row needing a flag the global layer leaves off is refused
 * on its own (`./flag-admission.ts`, `./keys/reserved.ts`).
 * The shape a module decodes against is the SDK's
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
import type {PrefixTable} from "@kampus/tuval-ui/keys";
import {Effect, FileSystem, Option, Result, Schema, SchemaIssue} from "effect";
import type {AuthoredModules} from "./authored-modules.ts";
import {globalLayer, projectLayer, reservedSeparator} from "./config-scope.ts";
import {projectStatesNoFlags, resolveFeatures} from "./flag-admission.ts";
import {ReservedDeskKeys} from "./keys/reserved.ts";
import {generationUrl, nextGeneration, takeGeneration} from "./module-generations.ts";
import type {ProjectId} from "./project-id.ts";
import {
	admitRows,
	nothingRemoved,
	type RowRefused,
	type SdkAdmission,
	type SdkRemoved,
} from "./sdk-admission.ts";

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
	/** The grammar the desk's shell row routes, whose reserved keys no project may bind. */
	readonly table: PrefixTable;
}

export interface ConfigLayers {
	/** The desk's own layer, read first. */
	readonly desk: DeskLayer;
	/** The global module: `<home>/.tuval/tuval.config.ts` unless the bin's `--config` names one. */
	readonly global: string;
	/** One layer per open project, in the order they opened (#9685). */
	readonly projects: ReadonlyArray<ProjectLayer>;
}

export interface ProjectLayer {
	/** The project whose scope this layer's rows and graph nodes run under. */
	readonly id: ProjectId;
	/** The project module: `<project>/.tuval/tuval.config.ts`. */
	readonly module: string;
	/** The project a subproject is nested under, which its connections may not reach (#9689). */
	readonly parent?: ProjectId;
}

/**
 * What one owner contributes to the desk: the desk and global layers together, or one project's
 * layer. A project opens and closes as a whole (#9685), so its rows, nodes, renderers and keys stay
 * together here rather than only inside the merge.
 */
export interface LayerConfig {
	readonly programs: ReadonlyArray<unknown>;
	readonly moduleRenderers: ReadonlyArray<ModuleRendererRef>;
	readonly graph: Graph;
	readonly keys: ReadonlyArray<BindingSource>;
	/** The layer modules that existed. */
	readonly sources: ReadonlyArray<string>;
	/** The rows refused for their SDK range or a flag left off (`./sdk-admission.ts`). */
	readonly refused: ReadonlyArray<RowRefused>;
	/** What those refusals took out, which a project layer naming it by bare id loses too. */
	readonly removed: SdkRemoved;
}

/** One project's layer as it was read. */
export interface LoadedProject {
	readonly layer: ProjectLayer;
	readonly config: LayerConfig;
}

/** One project's layer read on its own, as a project opening into a running desk reads it. */
export interface LoadedProjectConfig extends LoadedProject {
	/** Every file this read loaded the layer from (`LoadedConfig.files`). */
	readonly files: ReadonlyArray<string>;
	/** The source this read compiled each of `files` from (`LoadedConfig.modules`). */
	readonly modules: AuthoredModules;
}

export interface LoadedConfig {
	/** The desk's and global layers' part of the merge below. */
	readonly desk: LayerConfig;
	/** Each project's part of the merge below, in the order the layers named them. */
	readonly projects: ReadonlyArray<LoadedProject>;
	/** The desk's rows, then the global layer's, then each project layer's under its project's scope. */
	readonly programs: ReadonlyArray<unknown>;
	/** The global layer's flags over the defaults. Flags are global only; a project states none. */
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
	/** Every owner's refused rows, global first; the rest of the config runs. */
	readonly refused: ReadonlyArray<RowRefused>;
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
	upstream: SdkRemoved,
	features: (config: TuvalConfig) => TuvalFeatures,
) {
	if (!(yield* present(modulePath))) return Option.none<SdkAdmission>();
	const config = yield* loadConfigModule(modulePath, load);
	const refuse = (reason: string) =>
		new ConfigLoadError({module: modulePath, reason, files: [modulePath]});
	const conflict = deskConflict(desk, config);
	if (Option.isSome(conflict)) return yield* refuse(conflict.value);
	const checked = Result.flatMap(reservedSeparator(config), check);
	if (Result.isFailure(checked)) return yield* refuse(checked.failure);
	// After the scope check, so a refused project row is named by its scoped id and its nodes match,
	// and a connection to a global row or node is still the bare id `upstream` names.
	return Option.some(admitRows(checked.success, {upstream, features: features(checked.success)}));
});

/**
 * A layer's part of the desk: its rows as declared rows — the last place a row and its layer module
 * are still together, and a module renderer resolves from the module that declared it — its nodes
 * and its keys. An absent module is an empty part.
 */
const partOf = (
	admission: Option.Option<SdkAdmission>,
	module: string,
	layer: ConfigLayer,
): {readonly declared: ReadonlyArray<DeclaredProgram>; readonly config: LayerConfig} => {
	if (Option.isNone(admission)) {
		return {
			declared: [],
			config: {
				programs: [],
				moduleRenderers: [],
				graph: {nodes: []},
				keys: [],
				sources: [],
				refused: [],
				removed: nothingRemoved,
			},
		};
	}
	const {config: loaded, refused, removed} = admission.value;
	const declared = declaredIn(loaded, module);
	return {
		declared,
		config: {
			// Widened back: the loader checked each row's id and nothing else, and that is all a caller
			// may assume of one.
			programs: declared.map((program): unknown => program.row),
			moduleRenderers: moduleRendererRefs(declared),
			graph: loaded.graph,
			keys: [bindingSource(layer, module, loaded.keys)],
			sources: [module],
			refused,
			removed,
		},
	};
};

/**
 * Several owners' renderer references as one list the page can key: each specifier once, the first
 * owner to name it keeping its origin, the way `moduleRendererRefs` dedupes within one list.
 */
export const firstPerRef = (
	refs: ReadonlyArray<ModuleRendererRef>,
): ReadonlyArray<ModuleRendererRef> => {
	const seen = new Map<string, ModuleRendererRef>();
	for (const ref of refs) if (!seen.has(ref.ref)) seen.set(ref.ref, ref);
	return [...seen.values()];
};

/** The desk's own rows and nodes, then the global layer's. */
const deskPart = (desk: DeskLayer, global: string, loaded: Option.Option<SdkAdmission>) => {
	const file = partOf(loaded, global, "global");
	const declared = [
		...desk.programs.map((row): DeclaredProgram => ({row, origin: desk.origin})),
		...file.declared,
	];
	return {
		...file.config,
		programs: declared.map((program): unknown => program.row),
		moduleRenderers: moduleRendererRefs(declared),
		graph: {nodes: [...desk.graph.nodes, ...file.config.graph.nodes]},
	} satisfies LayerConfig;
};

/** A project layer as it runs: no flags, no reserved desk key, and every id under its project. */
const projectCheck =
	(desk: DeskLayer, project: ProjectLayer): LayerCheck =>
	(config) =>
		Result.flatMap(projectStatesNoFlags(config), (stated) =>
			Result.flatMap(ReservedDeskKeys.of(desk.table).refuseIn(stated.keys), () =>
				projectLayer(project.id, stated, project.parent),
			),
		);

const loadProjectLayer = (
	desk: DeskLayer,
	project: ProjectLayer,
	load: number,
	global: SdkRemoved,
	features: TuvalFeatures,
) =>
	Effect.map(
		loadOptional(project.module, load, desk, projectCheck(desk, project), global, () => features),
		(loaded): LoadedProject => ({
			layer: project,
			config: partOf(loaded, project.module, "project").config,
		}),
	);

/**
 * `load` run under one module generation, beside every file that generation imported. A refusal
 * carries those files too, and so does whatever `readBefore` names: a watcher needs every file the
 * refused read touched.
 */
const recorded = <A>(
	load: number,
	read: Effect.Effect<A, ConfigLoadError, FileSystem.FileSystem>,
	readBefore: (
		error: ConfigLoadError,
	) => Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem>,
) =>
	read.pipe(
		Effect.catch((error) =>
			Effect.gen(function* () {
				const imported = takeGeneration(load).files;
				const before = yield* readBefore(error);
				return yield* new ConfigLoadError({
					module: error.module,
					reason: error.reason,
					files: [...new Set([...before, ...error.files, ...imported])],
				});
			}),
		),
		// A defect or an interrupt still drops the record; the refusal above already took it.
		Effect.onError(() => Effect.sync(() => takeGeneration(load))),
		Effect.map((value) => {
			const {files: imported, modules} = takeGeneration(load);
			return {value, imported, modules};
		}),
	);

/**
 * The desk layer, then the global layer, then each project's, absent ones empty. The desk's rows and
 * nodes come first and no file may redeclare them; the global layer's follow, then each project
 * layer's under its project's scope, and none replaces another.
 */
export const loadLayeredConfig = Effect.fn("Tuval.loadLayeredConfig")(function* (
	layers: ConfigLayers,
) {
	const load = nextGeneration();
	const {
		value: read,
		imported,
		modules,
	} = yield* recorded(
		load,
		Effect.gen(function* () {
			const global = yield* loadOptional(
				layers.global,
				load,
				layers.desk,
				globalLayer,
				nothingRemoved,
				(config) => resolveFeatures(config.features),
			);
			const removed = Option.match(global, {
				onNone: () => nothingRemoved,
				onSome: (admission) => admission.removed,
			});
			const features = Option.match(global, {
				onNone: () => featuresDefault,
				onSome: (admission) => resolveFeatures(admission.config.features),
			});
			const projects = yield* Effect.forEach(
				layers.projects,
				(project) => loadProjectLayer(layers.desk, project, load, removed, features),
				{concurrency: 1},
			);
			return {global, projects, features};
		}),
		// A project layer loads after the global one, so a refusal there read the global one first.
		(error) =>
			error.module !== layers.global
				? Effect.map(present(layers.global), (there) => (there ? [layers.global] : []))
				: Effect.succeed([]),
	);
	const desk = deskPart(layers.desk, layers.global, read.global);
	const parts = [desk, ...read.projects.map((project) => project.config)];
	const sources = parts.flatMap((part) => part.sources);
	return {
		desk,
		projects: read.projects,
		programs: parts.flatMap((part) => part.programs),
		features: read.features,
		moduleRenderers: firstPerRef(parts.flatMap((part) => part.moduleRenderers)),
		graph: {nodes: parts.flatMap((part) => part.graph.nodes)},
		keys: parts.flatMap((part) => part.keys),
		sources,
		refused: parts.flatMap((part) => part.refused),
		files: [...new Set([...sources, ...imported])],
		modules,
	} satisfies LoadedConfig;
});

/**
 * One project's layer on its own, as a project opening into a running desk reads it (#9685). The
 * desk layer is what it may not redeclare; the global layer is not read again, because a project's
 * connections to a global row name its bare id and resolve against the running registry. `global`
 * is what the running desk's global layer lost to its refusals, read with the graph it runs, and
 * `features` the flags it runs under, which a project row's `needsFeatures` is checked against.
 */
export const loadProjectConfig = Effect.fn("Tuval.loadProjectConfig")(function* (
	desk: DeskLayer,
	project: ProjectLayer,
	global: SdkRemoved,
	features: TuvalFeatures,
) {
	const load = nextGeneration();
	const {value, imported, modules} = yield* recorded(
		load,
		loadProjectLayer(desk, project, load, global, features),
		() => Effect.succeed([]),
	);
	return {
		...value,
		files: [...new Set([...value.config.sources, ...imported])],
		modules,
	} satisfies LoadedProjectConfig;
});
