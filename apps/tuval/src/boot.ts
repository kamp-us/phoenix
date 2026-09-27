import {homedir} from "node:os";
import {join, resolve} from "node:path";
import {
	AiAgentSessionList,
	aiAgentSessionListKernel,
} from "@kampus/tuval-sdk/kernel/ai-agent/session-list";
import {
	AiAgentTranscripts,
	aiAgentTranscriptsKernel,
} from "@kampus/tuval-sdk/kernel/ai-agent/session-transcript";
import type {BindingError, BindingSource} from "@kampus/tuval-sdk/kernel/commands/bindings/index";
import {everyRegistered, SpellBridge} from "@kampus/tuval-sdk/kernel/commands/bridge/index";
import {helpSpells} from "@kampus/tuval-sdk/kernel/commands/core/index";
import {processSpells, SpawnedProcesses} from "@kampus/tuval-sdk/kernel/commands/core/process";
import {SpellExecutor} from "@kampus/tuval-sdk/kernel/commands/executor";
import type {SpellRegistry} from "@kampus/tuval-sdk/kernel/commands/registry";
import type {WindowIndex} from "@kampus/tuval-sdk/kernel/commands/scope";
import type {AnySpell} from "@kampus/tuval-sdk/kernel/commands/spell";
import {SpellSet} from "@kampus/tuval-sdk/kernel/commands/spell-set";
import {Checkpoints} from "@kampus/tuval-sdk/kernel/durability/Checkpoints";
import {restore} from "@kampus/tuval-sdk/kernel/durability/restore";
import {fileStores} from "@kampus/tuval-sdk/kernel/durability/stores";
import {Features} from "@kampus/tuval-sdk/kernel/feature-flags";
import {compile} from "@kampus/tuval-sdk/kernel/ports/compile";
import type {Graph} from "@kampus/tuval-sdk/kernel/ports/graph";
import {open} from "@kampus/tuval-sdk/kernel/ports/wiring";
import {PlannedProcesses} from "@kampus/tuval-sdk/kernel/process/PlannedProcesses";
import {Processes} from "@kampus/tuval-sdk/kernel/process/Processes";
import {ProcessTable} from "@kampus/tuval-sdk/kernel/process/ProcessTable";
import type {ProcessHandle} from "@kampus/tuval-sdk/kernel/process/process";
import {WorkingFolder} from "@kampus/tuval-sdk/kernel/process/working-folder";
import type {AnyProgram} from "@kampus/tuval-sdk/kernel/registry/program";
import {Registry, RegistryRows} from "@kampus/tuval-sdk/kernel/registry/Registry";
import {scopedIdParts} from "@kampus/tuval-sdk/kernel/registry/scoped-id";
import type {SdkRefused} from "@kampus/tuval-sdk/kernel/registry/sdk-range";
import type {ModuleRendererRef} from "@kampus/tuval-sdk/kernel/shell/window/index";
import {homeTuvalDir, type StateAdoption, StateDir} from "@kampus/tuval-sdk/kernel/state-dir";
import type {PrefixTable} from "@kampus/tuval-ui/keys";
import {Context, Deferred, Effect, FileSystem, Layer} from "effect";
import {AuthoredModules} from "./authored-modules.ts";
import {
	type ConfigLoadError,
	type DeskLayer,
	type LoadedConfig,
	type LoadedProjectConfig,
	loadLayeredConfig,
	type ProjectLayer,
	type TuvalFeatures,
} from "./config.ts";
import {ConfigGeneration} from "./config-generation.ts";
import {deskLayer} from "./desk-layer.ts";
import type {CheckpointScoping} from "./durability/scope-checkpoints.ts";
import {type LaunchedProcess, launch} from "./launch/launch.ts";
import {ProjectId, projectConfig} from "./project-id.ts";
import {checkpointRoutes, ownedView} from "./projects/checkpoint-routes.ts";
import {
	makeProjects,
	type ProjectOpened,
	type ProjectState,
	Projects,
	type ProjectsKernel,
	prepareProjectState,
} from "./projects/Projects.ts";
import {projectSpells} from "./projects/spells.ts";
import {makeTrustPrompts, TrustPrompts} from "./projects/TrustPrompts.ts";
import {ConfigReloader, type ReloadRefused, type ReloadReport} from "./reload.ts";
import type {SdkRemoved} from "./sdk-admission.ts";
import type {ShellDispatch} from "./shell/commands/dispatch.ts";
import {shellDispatchKernel, shellWindowIndexKernel} from "./shell/commands/kernel.ts";
import {shellId, shellPrefixTable, withShellFeatures} from "./shell/program.ts";
import {ProcessTablePort} from "./table/ProcessTablePort.ts";

export {projectConfig, projectDir} from "./project-id.ts";

/** The global config module, `~/.tuval/tuval.config.ts`; the home dir is a parameter so a test can point it elsewhere. */
export const defaultGlobalConfig = (home: string = homedir()): string =>
	join(homeTuvalDir(home), "tuval.config.ts");

export type Kernel =
	| Registry
	// The merged feature flags. A program row's layer reads what the config layers resolved through
	// this and nothing else: the row is built while a config module is being evaluated, which is
	// before the merge exists (#8595).
	| Features
	// The session-list spell's own requirement, filled from the built kernel below: the union it
	// answers builds each backend's layer under the context a spawn of that row would run under.
	| AiAgentSessionList
	// The transcript spell's own requirement, filled the same way: one named backend's layer, built
	// to read a session's history without opening a process on it.
	| AiAgentTranscripts
	| Checkpoints
	| Processes
	// The graph-declared process ids `launch` records and `Processes.remove` refuses on (#9446).
	| PlannedProcesses
	| ProcessTable
	| ProcessTablePort
	| SpawnedProcesses
	// The desk's state directory, so a row's layer can put its own files beside the checkpoints
	// instead of deriving a directory from a session's cwd (`./state-dir.ts`, ADR 0402).
	| StateDir
	| SpellSet
	| SpellRegistry
	| WindowIndex
	| SpellExecutor
	| SpellBridge
	// What the shell's `config:reload` handler runs (`./reload.ts`): a handler reaches only its row's
	// `R`, so the reload has to be a kernel service to be reachable from a key at all.
	| ConfigReloader
	// The open projects, which the `project` spells open and close (`./projects/`, #9685).
	| Projects
	// The "Trust this folder?" questions an open is waiting on, which every page is sent (#9693).
	| TrustPrompts
	// Naming it here is what makes the provider load-bearing to the checker: `Context` is
	// contravariant in its services, so dropping `shellDispatchKernel` below stops `start`'s
	// answer from satisfying `Started` rather than leaving a defect for the first caller (#7774).
	| ShellDispatch;

/** The spells the kernel registers itself: discovery, the generic process tools, and projects. */
export const coreSpells: ReadonlyArray<AnySpell> = [
	...helpSpells,
	...processSpells,
	...projectSpells,
];

/** How long `process read` waits on a port that has said nothing yet before answering none. */
const READ_TIMEOUT = "1 second";

/** The project a desk boots with, its config already read and its state already prepared. */
export interface FirstProject {
	readonly folder: string;
	readonly loaded: LoadedProjectConfig;
	readonly state: ProjectState;
}

/** The desk a kernel opens projects into (`./projects/Projects.ts`). */
export interface DeskProjects {
	/** The home dir every project's state hangs under (ADR 0402). */
	readonly home: string;
	readonly desk: DeskLayer;
	/** The desk's and global layers' module renderers. */
	readonly renderers: ReadonlyArray<ModuleRendererRef>;
	/** What the global layer's SDK refusals took out of the graph this kernel runs (#9686). */
	readonly removed: SdkRemoved;
	readonly first?: FirstProject;
	/** What a project's config and state are read through. */
	readonly fs: FileSystem.FileSystem;
}

export interface StartOptions {
	/** The desk's and global layers' rows. A project's rows join when it opens. */
	readonly programs: ReadonlyArray<AnyProgram>;
	readonly graph: Graph;
	readonly stateDir: string;
	/**
	 * The config's key bindings, one source per layer, compiled against the registered spells.
	 * Absent for a caller that has no config layers to offer, which is every caller but `boot`.
	 */
	readonly keys?: ReadonlyArray<BindingSource>;
	/**
	 * The merged feature flags this kernel runs under. Absent for a caller with no config layers to
	 * merge — every caller but `boot` — which is what `featuresDefault` means.
	 */
	readonly features?: TuvalFeatures;
	/**
	 * How to read the config these rows came from again, given the projects open at the time. Absent
	 * for a caller that was handed rows and no config — every caller but `boot` — and that kernel's
	 * reload refuses with `NoConfigToReload`.
	 */
	readonly reread?: (
		projects: ReadonlyArray<ProjectLayer>,
	) => Effect.Effect<ConfigGeneration, ConfigLoadError>;
	/**
	 * The desk this kernel opens projects into. Absent for a caller handed rows, whose `Projects`
	 * refuses every open (`Projects.none`).
	 */
	readonly projects?: DeskProjects;
	/**
	 * The author's modules `programs` were built from, so the first reload can tell an edited helper.
	 * Absent for a caller handed rows and no config.
	 */
	readonly modules?: AuthoredModules;
}

export interface Started {
	readonly kernel: Context.Context<Kernel>;
	/** The graph's processes, in node order. */
	readonly launched: ReadonlyArray<LaunchedProcess>;
	/** Checkpointed processes the graph did not plan, spawned back by `restore`. */
	readonly restored: ReadonlyArray<ProcessHandle>;
	/** The first project, opened once the desk's own processes were up. */
	readonly first?: ProjectOpened;
}

/** A manifest entry the desk's own restore brings back: one no project's row owns. */
const deskOwned = (entry: {readonly programId: string}): boolean =>
	scopedIdParts(entry.programId).scope === undefined;

/**
 * The app from rows and a graph, built into the caller's Scope. The graph is compiled over the
 * registry before any process exists, so a bad route refuses here with nothing spawned and
 * nothing written; the wiring opens next and the kernel after it, so a stop takes the processes
 * down — pumps included — before their queues close. A snapshot under a definition the program's
 * own `migrations` do not reach refuses the boot at its spawn, with nothing fresh-booted
 * (#7467, #7514).
 *
 * The registry grows and shrinks and the checkpoint store routes by project, so a project opens
 * into this kernel after it is built (#9685); `options.projects.first` is the one `boot` opens.
 */
export const start = Effect.fn("Tuval.start")(function* ({
	programs,
	graph,
	stateDir,
	keys,
	features,
	reread,
	projects,
	modules = AuthoredModules.none,
}: StartOptions) {
	const registry = yield* Layer.build(Registry.growable(programs));
	const compiled = yield* compile(graph).pipe(Effect.provideContext(registry));
	const wiring = yield* open(compiled);
	const spells = yield* Layer.build(SpellSet.layer({core: coreSpells, programs, keys: keys ?? []}));
	// The desk's own store over its state directory; a project's processes are routed to its own.
	const deskStore = Context.get(
		yield* Layer.build(Checkpoints.layer(fileStores(stateDir))),
		Checkpoints,
	);
	const routes = checkpointRoutes(deskStore);
	// No program row supplies an allowance yet (`.patterns/tuval-spells.md`, "The bridge"), so boot
	// allows the whole registry — as a rule the bridge re-reads, so a reload moves it (#7743).
	const commands = Layer.mergeAll(
		SpellBridge.layer({allow: everyRegistered}),
		SpawnedProcesses.layer({readTimeout: READ_TIMEOUT}),
		// Every shell command row is registered as a spell whose `execute` needs this, and the
		// registry erases that requirement, so the composition root is where it is owed (#7774).
		// `boot` always hands `start` the desk layer's shell; a caller that hands rows without one
		// leaves this dispatcher with no process to find, which is a `NoDesk` refusal, not a failed boot.
		shellDispatchKernel(shellId),
	).pipe(
		Layer.provideMerge(SpellExecutor.layer),
		Layer.provideMerge(
			Layer.mergeAll(Layer.succeedContext(spells), shellWindowIndexKernel(shellId)),
		),
	);
	const reloader = ConfigReloader.fromConfig({
		core: coreSpells,
		initial: ConfigGeneration.of({programs, keys: keys ?? [], sources: []}, {files: [], modules}),
		...(reread === undefined ? {} : {read: reread}),
	}).pipe(Layer.provide(Layer.succeedContext(spells)));
	const built = yield* Layer.build(
		Layer.mergeAll(
			ProcessTablePort.layer,
			Features.layer(features),
			StateDir.layer(stateDir),
			commands,
			reloader,
		).pipe(
			Layer.provideMerge(Processes.layer),
			Layer.provideMerge(Layer.succeed(Checkpoints, routes.checkpoints)),
			Layer.provideMerge(Layer.succeedContext(registry)),
		),
	);
	const filled = yield* Deferred.make<Context.Context<ProjectsKernel>>();
	const prompts = projects === undefined ? TrustPrompts.none : yield* makeTrustPrompts;
	const desk =
		projects === undefined
			? undefined
			: yield* makeProjects({
					home: projects.home,
					desk: projects.desk,
					features: Context.get(built, Features),
					deskStateDir: stateDir,
					deskStore,
					routes,
					rows: Context.get(registry, RegistryRows),
					reloader: Context.get(built, ConfigReloader),
					prompts,
					deskGraph: graph,
					deskRemoved: projects.removed,
					deskWiring: wiring,
					deskRenderers: projects.renderers,
					scope: yield* Effect.scope,
					kernel: filled,
					fs: projects.fs,
				});
	// Added to the context it reads rather than layered into it: the session list builds every
	// registered backend's layer, and those layers need the kernel this call is closing over — a
	// layer inside the merge above would be asking for itself.
	const listing = Context.add(built, AiAgentSessionList, aiAgentSessionListKernel(built));
	const transcripts = Context.add(listing, AiAgentTranscripts, aiAgentTranscriptsKernel(listing));
	const services = Context.add(
		Context.add(transcripts, Projects, desk?.service ?? Projects.none),
		TrustPrompts,
		prompts,
	);
	// The desk's own processes run in the home folder, and so does whatever they start without
	// naming another; a project's processes run in its folder instead (#9694).
	const kernel =
		projects === undefined ? services : Context.add(services, WorkingFolder, {path: projects.home});
	yield* Deferred.succeed(filled, kernel);
	// The kernel reaches a process's handlers on one route only, the `services` argument: a handler
	// is sealed to its spawn set, so the ambient a spawner is called under can no longer stand in
	// for a `services` that forgot something (#7972). What each spawner is *called* under is
	// therefore its own `R` and nothing more — the services `launch` and `restore` name for
	// themselves, not the kernel a second time. `SpawnedProcesses` is among them since #8944:
	// `launch` enrols every node it spawns there, so one table answers the process spells for a
	// planned program and an ad-hoc one alike.
	const spawnerNeeds = Context.pick(
		Checkpoints,
		PlannedProcesses,
		Processes,
		ProcessTable,
		Registry,
		SpawnedProcesses,
	)(kernel);
	// The kernel rides into every launched process's handlers: the shell row's Cmds spawn programs
	// and read the process table, and a program row declares exactly those needs as its `R`.
	const launched = yield* launch(compiled, wiring, {services: kernel}).pipe(
		Effect.provideContext(spawnerNeeds),
	);
	// The same kernel a launched process gets, so a row's `R` is satisfied whichever spawner brings
	// it up (#7951). What still differs is the ports: the graph does not own a restored process, so
	// restore builds it an un-wired `ProcessPorts` of its own (#7789). A project's own checkpoints are
	// its open's to restore, once its rows are registered.
	const restored = yield* restore(kernel).pipe(
		Effect.provideService(Checkpoints, ownedView(deskStore, deskOwned)),
		Effect.provideContext(spawnerNeeds),
	);
	const first =
		desk === undefined || projects?.first === undefined
			? undefined
			: yield* desk.openFirst(projects.first.folder, projects.first.loaded, projects.first.state);
	return {
		kernel,
		launched,
		restored,
		...(first === undefined ? {} : {first}),
	} satisfies Started;
});

export interface BootOptions {
	/** The global config module's path. */
	readonly global: string;
	/** The project directory. Its `.tuval/` holds the project config layer, and no state. */
	readonly project: string;
	/**
	 * The home dir this desk's state hangs under. Required, not defaulted: a boot that named none
	 * would write this desk's manifest, checkpoints and Pi session files into the operator's own
	 * `~/.tuval`, which is what every test and proof here must not do. `src/bin.ts` is the one
	 * caller that names the real home dir.
	 */
	readonly home: string;
	/**
	 * The layer the desk supplies below the global config. Absent means `deskLayer`, the shell every
	 * desk runs; a test that boots a shell with a rebound key table hands its own.
	 */
	readonly desk?: DeskLayer;
}

export interface BootReport {
	/** The config modules that existed and were merged, global first. */
	readonly sources: ReadonlyArray<string>;
	readonly programCount: number;
	/** Every registered spell: the kernel's own, plus the ones the config's programs declare. */
	readonly spellCount: number;
	readonly bindingCount: number;
	/** One per key binding that did not compile; the binding is dropped and the rest still run. */
	readonly bindingErrors: ReadonlyArray<BindingError>;
	/** One per row refused for its SDK range; the row is not loaded and the rest still run (#9686). */
	readonly refused: ReadonlyArray<SdkRefused>;
	/** The home-dir directory this desk's state lives in, keyed by the project's absolute path. */
	readonly stateDir: string;
	/** What ADR 0402 rule 7's one-time move lifted out of `<project>/.tuval` on this boot. */
	readonly adopted: StateAdoption;
	/** What the one-time move onto project-scoped ids moved on this boot (#9684). */
	readonly scoped: CheckpointScoping;
	readonly processCount: number;
	readonly restoredCount: number;
}

export interface Booted {
	readonly report: BootReport;
	readonly kernel: Context.Context<Kernel>;
	/**
	 * The `kind: "module"` window specifiers the booted rows declared, each beside the config module
	 * that declared it. The page server resolves every one from its own origin, so it is carried out
	 * of the config load rather than recomputed from the registry, whose rows have lost their layer.
	 * A project opened later adds its own through `Projects.renderers`.
	 */
	readonly moduleRenderers: ReadonlyArray<ModuleRendererRef>;
	/**
	 * The merged feature flags, every one resolved to a boolean. Carried out of the boot because the
	 * page server generates them into a module the browser imports — without that they stay on this
	 * side and an operator who turns one on sees nothing (#8439).
	 */
	readonly features: TuvalFeatures;
	/**
	 * The key grammar the booted shell row was built with. Carried out of the boot because the
	 * transport sends it to every attached page (ADR 0353) and is started from `src/bin.ts`, which
	 * holds the kernel and not the config — before this it named `defaultPrefixTable` a second time,
	 * so a config-set table reached the shell row and nothing else (#7890).
	 */
	readonly keyTable: PrefixTable;
	/** Every file boot read the config from, which is what a desk watches (`LoadedConfig.files`). */
	readonly files: ReadonlyArray<string>;
	/** The kernel's `ConfigReloader`, run once (`./reload.ts`). */
	readonly reload: Effect.Effect<ReloadReport, ReloadRefused>;
}

/**
 * A loaded config as the kernel runs it, owner by owner. Config rows are trusted local code
 * (#7484 R1.1); the loader checks each row's id, not its shape. The flags are applied here: a config
 * module is evaluated before the merge exists (#8595), so this is the only place that holds both the
 * rows and what the layers said about them (#8867).
 */
const generationOf = (config: LoadedConfig): ConfigGeneration => {
	const rows = (programs: ReadonlyArray<unknown>) =>
		withShellFeatures(programs as ReadonlyArray<AnyProgram>, config.features);
	return config.projects.reduce(
		(generation, project) =>
			generation.withProject(
				project.layer,
				{
					programs: rows(project.config.programs),
					keys: project.config.keys,
					sources: project.config.sources,
				},
				{files: [], modules: AuthoredModules.none},
			),
		ConfigGeneration.of(
			{programs: rows(config.desk.programs), keys: config.desk.keys, sources: config.desk.sources},
			{files: config.files, modules: config.modules},
		),
	);
};

/** `start` from the layered config: the `pnpm dev` path. The `--project` folder is the first open. */
export const boot = Effect.fn("Tuval.boot")(function* (options: BootOptions) {
	const folder = resolve(options.project);
	const desk = options.desk ?? deskLayer;
	const firstLayer: ProjectLayer = {id: ProjectId.of(folder), module: projectConfig(folder)};
	const config = yield* loadLayeredConfig({desk, global: options.global, projects: [firstLayer]});
	const fs = yield* FileSystem.FileSystem;
	const reread = (projects: ReadonlyArray<ProjectLayer>) =>
		loadLayeredConfig({desk, global: options.global, projects}).pipe(
			Effect.map(generationOf),
			Effect.provideService(FileSystem.FileSystem, fs),
		);
	const [read] = config.projects;
	if (read === undefined) return yield* Effect.die("the boot project's layer was not read");
	const loaded: LoadedProjectConfig = {...read, files: config.files, modules: config.modules};
	// The desk's own checkpoints share the first project's state directory, so its state is prepared
	// — adopted and moved onto scoped ids — before the desk restores anything from it.
	const state = yield* prepareProjectState(folder, options.home, loaded);
	const deskRows = withShellFeatures(
		config.desk.programs as ReadonlyArray<AnyProgram>,
		config.features,
	);
	const started = yield* start({
		programs: deskRows,
		graph: config.desk.graph,
		stateDir: state.stateDir,
		keys: config.desk.keys,
		features: config.features,
		reread,
		projects: {
			home: options.home,
			desk,
			renderers: config.desk.moduleRenderers,
			removed: config.desk.removed,
			first: {folder, loaded, state},
			fs,
		},
		modules: config.modules,
	});
	const live = yield* ProcessTable.use((table) => table.list).pipe(
		Effect.provideContext(started.kernel),
	);
	const registered = yield* Registry.use((registry) => registry.list).pipe(
		Effect.provideContext(started.kernel),
	);
	const spells = yield* SpellSet.use((set) => set.read).pipe(Effect.provideContext(started.kernel));
	const restoredBy = (launched: ReadonlyArray<LaunchedProcess>, restored: ReadonlyArray<unknown>) =>
		launched.filter((process) => process.restored).length + restored.length;
	const report: BootReport = {
		sources: config.sources,
		programCount: registered.length,
		spellCount: spells.table.rows.length,
		bindingCount: spells.bindings.bindings.length,
		bindingErrors: spells.bindings.errors,
		refused: config.refused,
		stateDir: state.stateDir,
		adopted: state.adopted,
		scoped: state.scoped,
		processCount: live.length,
		restoredCount:
			restoredBy(started.launched, started.restored) +
			(started.first === undefined
				? 0
				: restoredBy(started.first.launched, started.first.restored)),
	};

	return {
		report,
		kernel: started.kernel,
		moduleRenderers: config.moduleRenderers,
		features: config.features,
		keyTable: shellPrefixTable(deskRows),
		files: config.files,
		reload: ConfigReloader.use((reloader) => reloader.reload).pipe(
			Effect.provideContext(started.kernel),
		),
	} satisfies Booted;
});
