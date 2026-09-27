/**
 * The projects a running desk has open (#9685, ruling #9668 R1.1 and R4.1). Opening a project joins
 * it to the desk live: its config layer is read, its state directory prepared (ADR 0402, unchanged),
 * its checkpoints routed to a store of its own, its rows registered, its spells and keys installed,
 * its graph launched on a wiring joined to the desk's, its checkpointed processes restored and its
 * module renderers handed to the page server. Closing it takes all of that back out, and the other
 * projects keep running.
 *
 * Everything an open adds is undone by a finalizer on the project's own child scope, registered in
 * the order it was added, so a close is one scope close and an open that fails halfway undoes
 * exactly what it had done. The last finalizer to run on a close is the first thing an open did:
 * processes stop before their wiring, their rows and their checkpoint route go.
 *
 * A folder with a `.tuval` config is asked about before any of that: importing its config module
 * runs its code, so an open that needs trust waits on the person's answer first, and a no imports
 * nothing (#9693, ruling #9668 R2.1). The wait holds no lock, so a question left unanswered never
 * stops another project opening or closing.
 */

import {resolve} from "node:path";
import type {SpawnedProcesses} from "@kampus/tuval-sdk/kernel/commands/core/process";
import {Checkpoints} from "@kampus/tuval-sdk/kernel/durability/Checkpoints";
import {restore} from "@kampus/tuval-sdk/kernel/durability/restore";
import {fileStores} from "@kampus/tuval-sdk/kernel/durability/stores";
import type {TuvalFeatures} from "@kampus/tuval-sdk/kernel/features";
import {compile} from "@kampus/tuval-sdk/kernel/ports/compile";
import {PortNotWired} from "@kampus/tuval-sdk/kernel/ports/errors";
import type {Graph} from "@kampus/tuval-sdk/kernel/ports/graph";
import {open, type Wiring} from "@kampus/tuval-sdk/kernel/ports/wiring";
import type {PlannedProcesses} from "@kampus/tuval-sdk/kernel/process/PlannedProcesses";
import {Processes} from "@kampus/tuval-sdk/kernel/process/Processes";
import {ProcessTable} from "@kampus/tuval-sdk/kernel/process/ProcessTable";
import type {ProcessHandle} from "@kampus/tuval-sdk/kernel/process/process";
import {WorkingFolder} from "@kampus/tuval-sdk/kernel/process/working-folder";
import type {AnyProgram} from "@kampus/tuval-sdk/kernel/registry/program";
import type {Registry, RegistryRows} from "@kampus/tuval-sdk/kernel/registry/Registry";
import type {SdkRefused} from "@kampus/tuval-sdk/kernel/registry/sdk-range";
import type {ModuleRendererRef} from "@kampus/tuval-sdk/kernel/shell/window/index";
import {
	adoptInProjectState,
	homeStateDir,
	prepareStateDir,
	type StateAdoption,
} from "@kampus/tuval-sdk/kernel/state-dir";
import {
	Context,
	Deferred,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Result,
	Schema,
	Scope,
	Semaphore,
	Stream,
	SubscriptionRef,
} from "effect";
import {
	type DeskLayer,
	firstPerRef,
	type LoadedProjectConfig,
	loadProjectConfig,
} from "../config.ts";
import {type CheckpointScoping, scopeCheckpoints} from "../durability/scope-checkpoints.ts";
import {type LaunchedProcess, launch} from "../launch/launch.ts";
import {type ProjectId, projectConfig, projectDir} from "../project-id.ts";
import type {ConfigReloader} from "../reload.ts";
import type {SdkRemoved} from "../sdk-admission.ts";
import {withShellFeatures} from "../shell/program.ts";
import {type CheckpointRoutes, ownedView} from "./checkpoint-routes.ts";
import {
	type OpenProject,
	OpenProjects,
	type ProjectAlreadyOpen,
	type ProjectNotOpen,
	readOpenProjects,
	saveOpenProjects,
} from "./open-projects.ts";
import type {TrustPrompts} from "./TrustPrompts.ts";
import {FolderNotTrusted} from "./trust.ts";

/** A project that could not open, and why. Nothing it had started is left running. */
export class ProjectOpenRefused extends Schema.TaggedError<ProjectOpenRefused>()(
	"tuval/ProjectOpenRefused",
	{folder: Schema.String, reason: Schema.String},
) {
	override get message(): string {
		return `could not open the project ${this.folder}: ${this.reason}`;
	}
}

/** Refused by a kernel handed rows and no desk to open projects into. */
export class NoProjectsHere extends Schema.TaggedError<NoProjectsHere>()(
	"tuval/NoProjectsHere",
	{},
) {
	override get message(): string {
		return "this kernel was started from rows, not from a desk, so it opens no projects";
	}
}

/** Where a project's saved state lives, and what preparing it moved (ADR 0402, #9684). */
export interface ProjectState {
	readonly stateDir: string;
	readonly adopted: StateAdoption;
	readonly scoped: CheckpointScoping;
}

export interface ProjectOpened {
	readonly project: OpenProject;
	readonly state: ProjectState;
	readonly programCount: number;
	/** The project's rows refused for their SDK range, which the rest of the project runs without. */
	readonly refused: ReadonlyArray<SdkRefused>;
	/** The project's graph, in node order. */
	readonly launched: ReadonlyArray<LaunchedProcess>;
	/** The project's checkpointed processes its graph did not plan, spawned back. */
	readonly restored: ReadonlyArray<ProcessHandle>;
}

export interface ProjectClosed {
	readonly project: OpenProject;
}

export class Projects extends Context.Service<
	Projects,
	{
		readonly open: (
			folder: string,
		) => Effect.Effect<
			ProjectOpened,
			ProjectAlreadyOpen | ProjectOpenRefused | FolderNotTrusted | NoProjectsHere
		>;
		readonly close: (
			folder: string,
		) => Effect.Effect<ProjectClosed, ProjectNotOpen | NoProjectsHere>;
		readonly list: Effect.Effect<ReadonlyArray<OpenProject>>;
		/** The open projects now, then after every open and close. */
		readonly changes: Stream.Stream<ReadonlyArray<OpenProject>>;
		/**
		 * Every `kind: "module"` renderer the desk's rows declare, each beside the config module that
		 * declared it: the current set first, then each set an open or a close leaves.
		 */
		readonly renderers: Stream.Stream<ReadonlyArray<ModuleRendererRef>>;
	}
>()("tuval/Projects") {
	/** A kernel with no desk: every open and close refuses, and nothing is ever open. */
	static readonly none: Projects["Service"] = Projects.of({
		open: () => Effect.fail(new NoProjectsHere()),
		close: () => Effect.fail(new NoProjectsHere()),
		list: Effect.succeed([]),
		changes: Stream.make([]),
		renderers: Stream.make([]),
	});
}

/** What an open project's processes are spawned and restored under. */
export type ProjectsKernel =
	| Checkpoints
	| PlannedProcesses
	| Processes
	| ProcessTable
	| Registry
	| SpawnedProcesses;

export interface ProjectsOptions {
	/** The home dir every project's state hangs under (ADR 0402). */
	readonly home: string;
	readonly desk: DeskLayer;
	/** The flags the desk runs under. A project opened later brings none of its own. */
	readonly features: TuvalFeatures;
	/** The desk's own state directory, and the store over it. */
	readonly deskStateDir: string;
	readonly deskStore: Checkpoints["Service"];
	readonly routes: CheckpointRoutes;
	readonly rows: RegistryRows["Service"];
	readonly reloader: ConfigReloader["Service"];
	/** Where an open that needs trust asks the person at the desk. */
	readonly prompts: TrustPrompts["Service"];
	/** The desk's and global layers' graph, and the wiring it was opened on. */
	readonly deskGraph: Graph;
	/** What the global layer's SDK refusals took out of `deskGraph`, which a project loses too. */
	readonly deskRemoved: SdkRemoved;
	readonly deskWiring: Wiring;
	/** The desk's and global layers' module renderers. */
	readonly deskRenderers: ReadonlyArray<ModuleRendererRef>;
	/** The scope every project's own scope is forked from. */
	readonly scope: Scope.Scope;
	/** The finished kernel, which a launched process's handlers are handed; filled once it is built. */
	readonly kernel: Deferred.Deferred<Context.Context<ProjectsKernel>>;
	readonly fs: FileSystem.FileSystem;
}

/** A project's state directory prepared, and anything an older build left moved onto it. */
export const prepareProjectState = Effect.fn("Tuval.prepareProjectState")(function* (
	folder: string,
	home: string,
	loaded: LoadedProjectConfig,
) {
	const {id} = loaded.layer;
	// Derived from the folder's absolute path and never joined onto it (ADR 0402). The adoption runs
	// before anything reads a checkpoint, and the move onto scoped ids after it, so state an older
	// build left in the project comes back whole and under the ids its rows now run at (#9684).
	const stateDir = yield* prepareStateDir(folder, homeStateDir(folder, home));
	const adopted = yield* adoptInProjectState(projectDir(folder), stateDir);
	const scoped = yield* scopeCheckpoints(stateDir, fileStores(stateDir), id, {
		programs: id.ownedLocals(loaded.config.programs.map(rowId)),
		nodes: id.ownedLocals(loaded.config.graph.nodes.map((node) => node.id)),
	});
	return {stateDir, adopted, scoped} satisfies ProjectState;
});

const rowId = (row: unknown): string => (row as {readonly id: string}).id;

const reasonOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

interface Renderers {
	readonly desk: ReadonlyArray<ModuleRendererRef>;
	readonly byProject: ReadonlyMap<string, ReadonlyArray<ModuleRendererRef>>;
}

const allRenderers = (renderers: Renderers): ReadonlyArray<ModuleRendererRef> =>
	firstPerRef([...renderers.desk, ...[...renderers.byProject.values()].flat()]);

/**
 * The service, beside the step `boot` opens its first project with: that project's config is
 * already read and its state already prepared, because the desk's own checkpoints share its state
 * directory and have to be moved before the desk restores anything.
 */
export const makeProjects = Effect.fn("Tuval.makeProjects")(function* (options: ProjectsOptions) {
	const {home, desk, routes, rows, reloader, prompts, fs} = options;
	const lock = yield* Semaphore.make(1);
	// Only the trust of the saved list is carried: which folders were open is a later slice's to
	// reopen. A list that cannot be read costs the remembered trust, and the folders are asked again.
	const saved = yield* readOpenProjects(home).pipe(
		Effect.provideService(FileSystem.FileSystem, fs),
		Effect.catch((error) =>
			Effect.as(
				Effect.logWarning(`tuval: could not read the open projects list — ${error.message}`),
				null,
			),
		),
	);
	const openRef = yield* SubscriptionRef.make(OpenProjects.restoring(saved));
	const scopes = new Map<string, Scope.Closeable>();
	const renderers = yield* SubscriptionRef.make<Renderers>({
		desk: options.deskRenderers,
		byProject: new Map(),
	});

	const storeAt = (stateDir: string) =>
		stateDir === options.deskStateDir
			? Effect.succeed(options.deskStore)
			: Effect.map(Layer.build(Checkpoints.layer(fileStores(stateDir))), (built) =>
					Context.get(built, Checkpoints),
				);

	/** The processes running one of the project's rows, stopped and left in their checkpoints. */
	const stopOwned = (id: ProjectId, kernel: Context.Context<ProjectsKernel>) =>
		Effect.gen(function* () {
			const processes = Context.get(kernel, Processes);
			for (const row of yield* Context.get(kernel, ProcessTable).list) {
				// A child the stop of its parent already took is gone by the time its turn comes.
				if (id.owns(row.programId)) yield* Effect.ignore(processes.stop(row.id));
			}
		});

	const attach = Effect.fn("Tuval.Projects.attach")(function* (
		project: OpenProject,
		loaded: LoadedProjectConfig,
		state: ProjectState,
	) {
		const {id} = project;
		const scope = yield* Scope.fork(options.scope);
		const added = Effect.gen(function* () {
			const store = yield* storeAt(state.stateDir);
			yield* routes.route(id.key, store);
			yield* Effect.addFinalizer(() => routes.unroute(id.key));

			const programs = withShellFeatures(
				loaded.config.programs as ReadonlyArray<AnyProgram>,
				options.features,
			);
			yield* rows.add(programs);
			yield* Effect.addFinalizer(() => rows.remove(programs.map((row) => row.id)));

			const read = {programs, keys: loaded.config.keys, sources: loaded.config.sources};
			yield* reloader.swap((current) =>
				Effect.succeed(current.withProject(loaded.layer, read, loaded)),
			);
			yield* Effect.addFinalizer(() =>
				reloader
					.swap((current) => Effect.succeed(current.withoutProject(id.key)))
					.pipe(Effect.catch((error) => Effect.logError(error))),
			);

			// The project's nodes compile beside the desk's, because a project node may route to a global
			// node or run under one; only the project's own nodes and routes are this wiring's.
			const kernel = yield* Deferred.await(options.kernel);
			const compiled = yield* compile({
				nodes: [...options.deskGraph.nodes, ...loaded.config.graph.nodes],
			}).pipe(Effect.provideContext(kernel));
			const own = new Set<string>(loaded.config.graph.nodes.map((node) => node.id));
			const part = {
				nodes: compiled.nodes.filter((node) => own.has(node.id)),
				routes: compiled.routes.filter((route) => own.has(route.source.node)),
			};
			const inPorts = new Map(compiled.nodes.map((node) => [node.id, node.inPorts]));
			const wiring = yield* open(part, (at) =>
				Effect.flatMap(options.deskWiring.inbox(at), (queue) => {
					const port = inPorts.get(at.node)?.[at.port];
					return port === undefined
						? Effect.fail(new PortNotWired(at))
						: Effect.succeed({queue, accepts: port.accepts});
				}),
			);
			yield* Effect.addFinalizer(() => stopOwned(id, kernel));

			// A project's processes run in its folder, and so does what they start (#9694).
			const inFolder = Context.add(kernel, WorkingFolder, {path: project.folder});
			const launched = yield* launch(part, wiring, {services: inFolder}).pipe(
				Effect.provideContext(kernel),
			);
			// The store may be the desk's, so the restore reads only the entries this project owns.
			const restored = yield* restore(inFolder).pipe(
				Effect.provideService(
					Checkpoints,
					ownedView(store, (entry) => id.owns(entry.programId)),
				),
				Effect.provideContext(kernel),
			);

			yield* SubscriptionRef.update(renderers, (current) => ({
				...current,
				byProject: new Map([...current.byProject, [id.key, loaded.config.moduleRenderers]]),
			}));
			yield* Effect.addFinalizer(() =>
				SubscriptionRef.update(renderers, (current) => {
					const byProject = new Map(current.byProject);
					byProject.delete(id.key);
					return {...current, byProject};
				}),
			);
			return {
				project,
				state,
				programCount: programs.length,
				refused: loaded.config.refused,
				launched,
				restored,
			} satisfies ProjectOpened;
		});
		const opened = yield* added.pipe(
			Effect.provideService(Scope.Scope, scope),
			Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit))),
			Effect.mapError(
				(cause) => new ProjectOpenRefused({folder: project.folder, reason: reasonOf(cause)}),
			),
		);
		scopes.set(id.key, scope);
		return opened;
	});

	/** The saved list follows the open one; a failed write costs the restart record, not the desk. */
	const save = (projects: OpenProjects) =>
		saveOpenProjects(home, projects).pipe(
			Effect.provideService(FileSystem.FileSystem, fs),
			Effect.catch((error) =>
				Effect.logWarning(`tuval: could not save the open projects list — ${error.message}`),
			),
		);

	/** Join a project whose config is read and whose state is prepared, then record it open. */
	const commitOpen = (project: OpenProject, loaded: LoadedProjectConfig, state: ProjectState) =>
		Effect.gen(function* () {
			const opened = yield* attach(project, loaded, state);
			const next = yield* SubscriptionRef.updateAndGet(openRef, (current) => {
				const result = current.open(project.folder);
				return Result.isSuccess(result) ? result.success.projects : current;
			});
			yield* save(next);
			return opened;
		});

	/** Remember that the person trusted `folder`, in the saved list as well as the open one. */
	const recordTrust = (folder: string) =>
		Effect.flatMap(
			SubscriptionRef.updateAndGet(openRef, (current) => current.trust(folder)),
			save,
		).pipe(lock.withPermits(1));

	/**
	 * Ask about `folder` when it holds a config nobody has trusted. Unlocked, because the person may
	 * take as long as they like; trust only ever grows, so an answer cannot go stale while it waits.
	 */
	const admit = Effect.fn("Tuval.Projects.admit")(function* (folder: string) {
		const current = yield* SubscriptionRef.get(openRef);
		const opening = current.open(folder);
		if (Result.isFailure(opening)) return yield* opening.failure;
		const isFolder = yield* fs.stat(folder).pipe(
			Effect.map((info) => info.type === "Directory"),
			Effect.orElseSucceed(() => false),
		);
		if (!isFolder) {
			return yield* new ProjectOpenRefused({folder, reason: "no folder is there"});
		}
		// A config that cannot be checked for is asked about, never assumed away.
		const hasConfig = yield* fs
			.exists(projectConfig(folder))
			.pipe(Effect.orElseSucceed(() => true));
		if (current.trusted.gate(folder, hasConfig) !== "ask") return;
		if ((yield* prompts.ask(folder)) === "refuse") return yield* new FolderNotTrusted({folder});
		yield* recordTrust(folder);
	});

	const openAdmitted = Effect.fn("Tuval.Projects.openAdmitted")(function* (folder: string) {
		const current = yield* SubscriptionRef.get(openRef);
		const opening = current.open(folder);
		if (Result.isFailure(opening)) return yield* opening.failure;
		const {project} = opening.success;
		const refuse = (cause: unknown) =>
			new ProjectOpenRefused({folder: project.folder, reason: reasonOf(cause)});
		// Checked again under the lock and just before the import: a config written into the folder
		// after `admit` found none must not be imported on a question nobody was asked.
		const hasConfig = yield* fs
			.exists(projectConfig(folder))
			.pipe(Effect.orElseSucceed(() => true));
		if (current.trusted.gate(folder, hasConfig) === "ask") {
			return yield* refuse("a .tuval config appeared after the folder was checked; open it again");
		}
		const layer = {id: project.id, module: projectConfig(folder)};
		const prepared = Effect.gen(function* () {
			const loaded = yield* loadProjectConfig(desk, layer, options.deskRemoved);
			const state = yield* prepareProjectState(folder, home, loaded);
			return {loaded, state};
		}).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.mapError(refuse));
		const {loaded, state} = yield* prepared;
		return yield* commitOpen(project, loaded, state);
	}, lock.withPermits(1));

	const openFolder = Effect.fn("Tuval.Projects.open")(function* (input: string) {
		const folder = resolve(input);
		yield* admit(folder);
		return yield* openAdmitted(folder);
	});

	const closeFolder = Effect.fn("Tuval.Projects.close")(function* (folder: string) {
		const closing = (yield* SubscriptionRef.get(openRef)).close(folder);
		if (Result.isFailure(closing)) return yield* closing.failure;
		const {project, projects} = closing.success;
		const scope = scopes.get(project.id.key);
		scopes.delete(project.id.key);
		if (scope !== undefined) yield* Scope.close(scope, Exit.void);
		yield* SubscriptionRef.set(openRef, projects);
		yield* save(projects);
		return {project} satisfies ProjectClosed;
	}, lock.withPermits(1));

	const service = Projects.of({
		open: openFolder,
		close: closeFolder,
		list: Effect.map(SubscriptionRef.get(openRef), (projects) => projects.projects),
		changes: Stream.map(SubscriptionRef.changes(openRef), (projects) => projects.projects),
		renderers: Stream.map(SubscriptionRef.changes(renderers), allRenderers),
	});

	/**
	 * `boot`'s first open: the project at `folder`, already read and prepared. Known gap: its config
	 * was imported before any page existed to ask from, so it skips the trust prompt, and `--project`
	 * defaults to the working directory, so nobody has to name it. Ruling #9668 R2.1 exempts only the
	 * home config; moving this open onto the trust gate is #9884.
	 */
	const openFirst = (folder: string, loaded: LoadedProjectConfig, state: ProjectState) =>
		Effect.gen(function* () {
			const project: OpenProject = {folder: resolve(folder), id: loaded.layer.id};
			return yield* commitOpen(project, loaded, state);
		}).pipe(lock.withPermits(1));

	return {service, openFirst};
});
