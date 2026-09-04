/**
 * The user-owned config: one versioned Schema for its shape, a fail-closed module loader, and the
 * two-layer merge — a global module under the home dir's `.tuval` and an optional project module
 * under the cwd's `.tuval`, project over global.
 *
 * Configuration is code the user owns (the Neovim model, #7484 R1.1): a TypeScript module whose
 * default export is a `{version: 1, programs, graph?, keys?}` config. Loading refuses on any defect the
 * loader can see — the module throwing, no default export, an export the schema rejects — and
 * every refusal names the module and the reason, so boot never runs on a half-read config. A
 * module that is not there is an empty layer, never a refusal: the layer is optional and the bin
 * refuses an explicitly named path before boot.
 *
 * Program rows stay opaque beyond the `id` the merge keys on — the row type is the registry
 * slice's, and Schema would strip a row's machine and handlers as excess keys. The graph is
 * decoded structurally; the ports slice refuses a malformed one when it compiles.
 */

import {dirname} from "node:path";
import {pathToFileURL} from "node:url";
import {Effect, FileSystem, Option, Predicate, Schema, SchemaIssue} from "effect";
import {
	type BindingSource,
	type ConfigLayer,
	describeFile,
	KeyBindings,
} from "./commands/bindings/index.ts";
import {type Graph, NodeId} from "./ports/graph.ts";
import {ProgramId} from "./registry/program.ts";

const hasStringId = (row: unknown): row is {readonly id: string} =>
	Predicate.isObject(row) && Predicate.isString((row as {readonly id?: unknown}).id);

const ProgramRow = Schema.Unknown.check(
	Schema.makeFilter(hasStringId, {message: "Expected a program row with a string id"}),
);

const PortRef = Schema.Struct({node: NodeId, port: Schema.String});

const GraphNode = Schema.Struct({
	id: NodeId,
	program: ProgramId,
	parent: Schema.optionalKey(NodeId),
	on: Schema.Array(Schema.Struct({port: Schema.String, to: PortRef})),
});

const GraphSchema = Schema.Struct({nodes: Schema.Array(GraphNode)});

/** Version 1 of the config shape. A config module default-exports its `Encoded` form. */
export const TuvalConfig = Schema.Struct({
	version: Schema.Literal(1),
	programs: Schema.Array(ProgramRow),
	graph: GraphSchema.pipe(Schema.withDecodingDefaultKey(Effect.succeed({nodes: []}))),
	/** Key to command string, read by the parser and compiled against the registry at boot. */
	keys: KeyBindings.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
});

export type TuvalConfig = typeof TuvalConfig.Type;
/** What a config module writes: plain strings for the ids, `graph` optional. */
export type TuvalConfigInput = typeof TuvalConfig.Encoded;

export class ConfigLoadError extends Schema.TaggedError<ConfigLoadError>()(
	"tuval/ConfigLoadError",
	{
		module: Schema.String,
		reason: Schema.String,
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

/**
 * Node caches an ES module by URL for the life of the process, so a second load of the same path
 * would answer with the config the first one read and a reload could never see an edit. Each load
 * stamps its own number on the URL to read the file as it stands now; the copy it replaces stays in
 * Node's cache, which is what reading a config twice costs. The number is per load and not per
 * module, so one load importing both layers imports a module they share exactly once.
 */
let loads = 0;
const nextLoad = (): number => (loads += 1);

const moduleUrl = (modulePath: string, load: number): string =>
	`${pathToFileURL(modulePath).href}?tuval-load=${load}`;

export const loadConfigModule = Effect.fn("Tuval.loadConfigModule")(function* (
	modulePath: string,
	load: number = nextLoad(),
) {
	const refuse = (reason: string) => new ConfigLoadError({module: modulePath, reason});
	const loaded = yield* Effect.tryPromise({
		try: (): Promise<Record<string, unknown>> => import(moduleUrl(modulePath, load)),
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
}

export interface LoadedConfig {
	readonly programs: ReadonlyArray<unknown>;
	readonly graph: Graph;
	/**
	 * One binding source per layer that existed, global first. They stay apart rather than merging
	 * into one record so a binding error names the module its author wrote it in; a later layer's
	 * binding for a key a lower layer also bound wins, because a key router reads the list in order.
	 */
	readonly keys: ReadonlyArray<BindingSource>;
	/** The layer modules that existed and were merged, global first. */
	readonly sources: ReadonlyArray<string>;
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

/** `over` replaces a `base` entry with the same key in place; the rest append in `over`'s order. */
const mergeById = <T>(base: ReadonlyArray<T>, over: ReadonlyArray<T>, key: (item: T) => string) => {
	const overrides = new Map(over.map((item) => [key(item), item] as const));
	const merged = base.map((item) => overrides.get(key(item)) ?? item);
	const baseKeys = new Set(base.map(key));
	return [...merged, ...over.filter((item) => !baseKeys.has(key(item)))];
};

const loadOptional = Effect.fn("Tuval.loadOptional")(function* (modulePath: string, load: number) {
	const fs = yield* FileSystem.FileSystem;
	const present = yield* fs.exists(modulePath).pipe(Effect.orElseSucceed(() => false));
	return present
		? Option.some(yield* loadConfigModule(modulePath, load))
		: Option.none<TuvalConfig>();
});

/** Both layers, absent ones empty, merged project-over-global by program id and node id. */
export const loadLayeredConfig = Effect.fn("Tuval.loadLayeredConfig")(function* (
	layers: ConfigLayers,
) {
	const load = nextLoad();
	const global = yield* loadOptional(layers.global, load);
	const project = yield* loadOptional(layers.project, load);
	const empty: TuvalConfig = {version: 1, programs: [], graph: {nodes: []}, keys: {}};
	const base = Option.getOrElse(global, () => empty);
	const over = Option.getOrElse(project, () => empty);
	return {
		programs: mergeById(base.programs, over.programs, rowId),
		graph: {nodes: mergeById(base.graph.nodes, over.graph.nodes, (node) => node.id)},
		keys: [
			...(Option.isSome(global) ? [bindingSource("global", layers.global, base.keys)] : []),
			...(Option.isSome(project) ? [bindingSource("project", layers.project, over.keys)] : []),
		],
		sources: [
			...(Option.isSome(global) ? [layers.global] : []),
			...(Option.isSome(project) ? [layers.project] : []),
		],
	} satisfies LoadedConfig;
});
