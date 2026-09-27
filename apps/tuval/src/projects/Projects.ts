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
 *
 * A desk restarting reopens the projects its saved list had open (#9688, ruling #9668 R5.1). Nobody
 * is asked anything on the way: a folder that is gone, or that holds a config no longer trusted, is
 * skipped with a notice naming it, and the others still open. Subprojects are not reopened here;
 * the program that opened one restores it (#9673 R2).
 *
 * A program opens a subproject under the project it runs in through the `Subprojects` service each
 * project puts in its processes' spawn set (#9689, ruling #9668 R4.3). A subproject asks nobody
 * about trust, because its parent is open and so already trusted; it keeps its own config, state
 * and rows, and its scope is forked from its parent's, so closing the parent closes it first. The
 * `ProcessBoundary` this answers keeps everyone but the opener from reaching across.
 */

import {isAbsolute, resolve} from "node:path";
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
import type {ProcessHandle, ProcessId, ProcessRow} from "@kampus/tuval-sdk/kernel/process/process";
import {
	CrossingRefused,
	ProcessBoundary,
	SubprojectRefused,
	Subprojects,
} from "@kampus/tuval-sdk/kernel/process/subprojects";
import {WorkingFolder} from "@kampus/tuval-sdk/kernel/process/working-folder";
import type {AnyProgram, ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import type {Registry, RegistryRows} from "@kampus/tuval-sdk/kernel/registry/Registry";
import {localId, scopedIdParts} from "@kampus/tuval-sdk/kernel/registry/scoped-id";
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
	Option,
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
import type {RowRefused, SdkRemoved} from "../sdk-admission.ts";
import {withShellFeatures} from "../shell/program.ts";
import {SubprojectBoundary} from "./boundary.ts";
import {type FolderUnreadable, listFolders} from "./browse.ts";
import {type CheckpointRoutes, ownedView} from "./checkpoint-routes.ts";
import type {FolderListing} from "./open-project-wire.ts";
import {
	type OpenProject,
	OpenProjects,
	ProjectAlreadyOpen,
	type ProjectNotOpen,
	ProjectNotReopened,
	projectLabels,
	type RecentProject,
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
	/** The project's rows refused for their SDK range or a flag left off; the rest of it runs. */
	readonly refused: ReadonlyArray<RowRefused>;
	/** The project's graph, in node order. */
	readonly launched: ReadonlyArray<LaunchedProcess>;
	/** The project's checkpointed processes its graph did not plan, spawned back. */
	readonly restored: ReadonlyArray<ProcessHandle>;
}

/** What a restart reopened from the saved list, and what it skipped with a notice. */
export interface ProjectsReopened {
	readonly opened: ReadonlyArray<ProjectOpened>;
	readonly skipped: ReadonlyArray<ProjectNotReopened>;
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
		/** The folders opened most recently, newest first, each saying whether it is open now. */
		readonly recent: Effect.Effect<ReadonlyArray<RecentProject>>;
		/**
		 * The subfolders of `folder`, or of the desk's home folder when none is named: what the
		 * picker's folder browser lists (#9697).
		 */
		readonly browse: (
			folder: string | undefined,
		) => Effect.Effect<FolderListing, FolderUnreadable | NoProjectsHere>;
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
		recent: Effect.succeed([]),
		browse: () => Effect.fail(new NoProjectsHere()),
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
	// A list that cannot be read costs the remembered trust and the reopen: the folders are asked
	// about again, and opened again by hand.
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

	/**
	 * The scope a project's own is forked from: the desk's, or a subproject's parent's, so a parent
	 * closing closes its subprojects before anything of its own.
	 */
	const scopeUnder = (project: OpenProject) => {
		if (project.under === undefined) return Effect.succeed(options.scope);
		const parent = scopes.get(project.under.parent.key);
		return parent === undefined
			? Effect.fail(
					new ProjectOpenRefused({
						folder: project.folder,
						reason: `the project it is nested under, ${project.under.parent.name}, is not open`,
					}),
				)
			: Effect.succeed(parent);
	};

	const attach = Effect.fn("Tuval.Projects.attach")(function* (
		project: OpenProject,
		loaded: LoadedProjectConfig,
		state: ProjectState,
		/** Done once the project is recorded open; a subproject its processes ask for waits on it. */
		ready: Deferred.Deferred<void>,
	) {
		const {id} = project;
		const scope = yield* Scope.fork(yield* scopeUnder(project));
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

			// A project's processes run in its folder, and so does what they start (#9694). What they
			// open as a subproject opens under this project (#9689).
			const inFolder = Context.add(
				Context.add(kernel, WorkingFolder, {path: project.folder}),
				Subprojects,
				subprojectsOf(project, scope, ready),
			);
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

	/** `current` with `project` recorded open, under its parent when it is a subproject. */
	const recorded = (current: OpenProjects, project: OpenProject): OpenProjects => {
		const {under} = project;
		const parent = current.projects.find((open) => open.id.key === under?.parent.key);
		const result =
			under === undefined
				? current.open(project.folder)
				: parent === undefined
					? undefined
					: current.openUnder(project.folder, parent.folder, under.opener);
		return result !== undefined && Result.isSuccess(result) ? result.success.projects : current;
	};

	/** Join a project whose config is read and whose state is prepared, then record it open. */
	const commitOpen = (project: OpenProject, loaded: LoadedProjectConfig, state: ProjectState) =>
		Effect.gen(function* () {
			const ready = yield* Deferred.make<void>();
			const opened = yield* attach(project, loaded, state, ready);
			const next = yield* SubscriptionRef.updateAndGet(openRef, (current) =>
				recorded(current, project),
			);
			yield* save(next);
			yield* Deferred.succeed(ready, undefined);
			return opened;
		});

	/** Remember that the person trusted `folder`, in the saved list as well as the open one. */
	const recordTrust = (folder: string) =>
		Effect.flatMap(
			SubscriptionRef.updateAndGet(openRef, (current) => current.trust(folder)),
			save,
		).pipe(lock.withPermits(1));

	/** What opening `folder` needs before its config is imported, or why it cannot open at all. */
	const gateOf = Effect.fn("Tuval.Projects.gateOf")(function* (folder: string) {
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
		return current.trusted.gate(folder, hasConfig);
	});

	/**
	 * Ask about `folder` when it holds a config nobody has trusted. Unlocked, because the person may
	 * take as long as they like; trust only ever grows, so an answer cannot go stale while it waits.
	 */
	const admit = Effect.fn("Tuval.Projects.admit")(function* (folder: string) {
		if ((yield* gateOf(folder)) !== "ask") return;
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
			const loaded = yield* loadProjectConfig(desk, layer, options.deskRemoved, options.features);
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
		const {project, projects, closed} = closing.success;
		// Each subproject before the project it is nested under, so a parent's processes outlive
		// nothing of their subprojects'.
		for (const each of closed) {
			const scope = scopes.get(each.id.key);
			scopes.delete(each.id.key);
			if (scope !== undefined) yield* Scope.close(scope, Exit.void);
		}
		yield* SubscriptionRef.set(openRef, projects);
		yield* save(projects);
		return {project} satisfies ProjectClosed;
	}, lock.withPermits(1));

	/** Take `folder` off the list a restart still has to reopen, in the saved list too. */
	const settle = (folder: string) =>
		Effect.flatMap(
			SubscriptionRef.updateAndGet(openRef, (current) => current.skip(folder)),
			save,
		).pipe(lock.withPermits(1));

	const notReopened = (folder: string, cause: unknown): ProjectNotReopened => {
		if (cause instanceof FolderNotTrusted) {
			return new ProjectNotReopened({folder, reason: "it is not trusted, so nothing from it ran"});
		}
		if (cause instanceof ProjectOpenRefused)
			return new ProjectNotReopened({folder, reason: cause.reason});
		return new ProjectNotReopened({folder, reason: reasonOf(cause)});
	};

	/**
	 * Reopen what the saved list had open and this desk has not opened yet, one folder at a time and
	 * in saved order, asking nobody: an untrusted config is skipped rather than asked about.
	 */
	const reopen = Effect.fn("Tuval.Projects.reopen")(function* () {
		const opened: Array<ProjectOpened> = [];
		const skipped: Array<ProjectNotReopened> = [];
		for (const folder of (yield* SubscriptionRef.get(openRef)).pending) {
			const tried = yield* Effect.gen(function* () {
				if ((yield* gateOf(folder)) === "ask") return yield* new FolderNotTrusted({folder});
				return yield* openAdmitted(folder);
			}).pipe(Effect.result);
			if (Result.isSuccess(tried)) {
				opened.push(tried.success);
				continue;
			}
			// Opened by hand while the restart was on its way to it: open, so nothing to say.
			if (!(tried.failure instanceof ProjectAlreadyOpen)) {
				skipped.push(notReopened(folder, tried.failure));
			}
			yield* settle(folder);
		}
		return {opened, skipped} satisfies ProjectsReopened;
	});

	/**
	 * Open `folder` as a subproject of `parent`, opened by `opener`. No trust is asked: the parent is
	 * open, so the person already trusted what runs there.
	 */
	const openSubAdmitted = Effect.fn("Tuval.Projects.openSubproject")(function* (
		parent: OpenProject,
		folder: string,
		opener: ProcessId,
	) {
		const current = yield* SubscriptionRef.get(openRef);
		const opening = current.openUnder(folder, parent.folder, opener);
		if (Result.isFailure(opening)) return yield* opening.failure;
		const {project} = opening.success;
		const refuse = (cause: unknown) =>
			new ProjectOpenRefused({folder: project.folder, reason: reasonOf(cause)});
		const isFolder = yield* fs.stat(folder).pipe(
			Effect.map((info) => info.type === "Directory"),
			Effect.orElseSucceed(() => false),
		);
		if (!isFolder) return yield* refuse("no folder is there");
		const layer = {id: project.id, module: projectConfig(folder), parent: parent.id};
		const {loaded, state} = yield* Effect.gen(function* () {
			const loaded = yield* loadProjectConfig(desk, layer, options.deskRemoved, options.features);
			const state = yield* prepareProjectState(folder, home, loaded);
			return {loaded, state};
		}).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.mapError(refuse));
		return yield* commitOpen(project, loaded, state);
	}, lock.withPermits(1));

	/**
	 * What a project's processes open subprojects through. An open is taken at once and carried out
	 * on the project's own scope once the project is recorded open, because a process asking from its
	 * restore runs inside that open; an open left when the project closes goes with it. A close is
	 * carried out before it answers, so its opener can act on a subproject that has stopped: only an
	 * open subproject closes, and one is open only after its parent is recorded open, so a close never
	 * waits on the open it runs inside.
	 */
	const subprojectsOf = (
		parent: OpenProject,
		scope: Scope.Scope,
		ready: Deferred.Deferred<void>,
	): Subprojects["Service"] => {
		const later = <A, E>(folder: string, request: Effect.Effect<A, E>) =>
			Effect.asVoid(
				Effect.forkIn(
					Deferred.await(ready).pipe(
						Effect.andThen(request),
						Effect.catch((error) =>
							Effect.logWarning(
								`tuval: the subproject ${folder} under ${parent.folder} — ${reasonOf(error)}`,
							),
						),
					),
					scope,
				),
			);
		const absolute = (folder: string) =>
			isAbsolute(folder)
				? Effect.succeed(resolve(folder))
				: Effect.fail(
						new SubprojectRefused({folder, reason: "name the folder by its absolute path"}),
					);
		return Subprojects.of({
			open: (opener, input) =>
				Effect.flatMap(absolute(input), (folder) =>
					later(folder, openSubAdmitted(parent, folder, opener)),
				),
			close: (opener, input) =>
				Effect.gen(function* () {
					const folder = yield* absolute(input);
					const open = (yield* SubscriptionRef.get(openRef)).find(folder);
					if (open?.under?.parent.key !== parent.id.key) {
						return yield* new SubprojectRefused({
							folder,
							reason: `it is not an open subproject of ${parent.folder}`,
						});
					}
					if (open.under.opener !== opener) {
						return yield* new SubprojectRefused({
							folder,
							reason: "only the program that opened it closes it",
						});
					}
					yield* closeFolder(folder).pipe(
						Effect.mapError((cause) => new SubprojectRefused({folder, reason: reasonOf(cause)})),
					);
				}),
		});
	};

	/** The open project a live process runs in: its program's, its graph node's, or its parent's. */
	const projectOf = (
		rows: ReadonlyMap<string, ProcessRow>,
		projects: ReadonlyArray<OpenProject>,
		id: ProcessId,
	): OpenProject | undefined => {
		const byScope = (scoped: string) => {
			const {scope} = scopedIdParts(scoped);
			return scope === undefined ? undefined : projects.find((open) => open.id.key === scope);
		};
		for (let at = rows.get(id); at !== undefined; ) {
			const owner = byScope(at.programId) ?? byScope(at.id);
			if (owner !== undefined) return owner;
			at = Option.isSome(at.parentId) ? rows.get(at.parentId.value) : undefined;
		}
		return undefined;
	};

	/** `program "<local id>" in <label>`, with no label for the desk's and global programs. */
	const described = (
		projects: ReadonlyArray<OpenProject>,
		programId: string,
		project: OpenProject | undefined,
	) => {
		const label = projectLabels(projects).find(({key}) => key === project?.id.key)?.label;
		const program = `program "${localId(programId)}"`;
		return label === undefined ? program : `${program} in ${label}`;
	};

	interface Target {
		readonly project: OpenProject | undefined;
		readonly programId: string;
	}

	/** Asked before a process sends to, asks, stops, reads or spawns into another (`./boundary.ts`). */
	const crossing = (
		from: ProcessId,
		target: (rows: ReadonlyMap<string, ProcessRow>, projects: ReadonlyArray<OpenProject>) => Target,
	) =>
		Effect.gen(function* () {
			const {projects} = yield* SubscriptionRef.get(openRef);
			if (!projects.some((project) => project.under !== undefined)) return;
			const kernel = yield* Deferred.await(options.kernel);
			const rows = new Map<string, ProcessRow>(
				(yield* Context.get(kernel, ProcessTable).list).map((row) => [row.id, row]),
			);
			const source = projectOf(rows, projects, from);
			const to = target(rows, projects);
			const reason = SubprojectBoundary.of(projects).refusal(
				{project: source, process: from},
				{project: to.project},
			);
			if (reason === undefined) return;
			return yield* new CrossingRefused({
				from: described(projects, rows.get(from)?.programId ?? from, source),
				to: described(projects, to.programId, to.project),
				reason,
			});
		});

	const boundary = ProcessBoundary.of({
		reach: (from, to) =>
			crossing(from, (rows, projects) => ({
				project: projectOf(rows, projects, to),
				programId: rows.get(to)?.programId ?? to,
			})),
		spawn: (from, program: ProgramId) =>
			crossing(from, (_rows, projects) => ({
				project: projects.find((open) => open.id.owns(program)),
				programId: program,
			})),
	});

	const service = Projects.of({
		open: openFolder,
		close: closeFolder,
		list: Effect.map(SubscriptionRef.get(openRef), (projects) => projects.projects),
		recent: Effect.map(SubscriptionRef.get(openRef), (projects) => projects.recentProjects),
		browse: (folder) =>
			Effect.flatMap(SubscriptionRef.get(openRef), (projects) =>
				listFolders(resolve(folder ?? home), (path) => projects.find(path) !== undefined),
			).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
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

	return {service, openFirst, reopen, boundary};
});
