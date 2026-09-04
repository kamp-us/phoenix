import {homedir} from "node:os";
import {join} from "node:path";
import {Context, Effect, type FileSystem, Layer} from "effect";
import type {BindingError, BindingSource} from "./commands/bindings/index.ts";
import {SpellBridge} from "./commands/bridge/index.ts";
import {helpSpells} from "./commands/core/index.ts";
import {processSpells, SpawnedProcesses} from "./commands/core/process.ts";
import type {DuplicateSpellPath, SpellNotDescribable} from "./commands/errors.ts";
import {SpellExecutor} from "./commands/executor.ts";
import type {SpellRegistry} from "./commands/registry.ts";
import {WindowIndex} from "./commands/scope.ts";
import type {AnySpell} from "./commands/spell.ts";
import {everyPath, SpellSet} from "./commands/spell-set.ts";
import {type ConfigLoadError, loadLayeredConfig} from "./config.ts";
import {Checkpoints} from "./durability/Checkpoints.ts";
import {restore} from "./durability/restore.ts";
import {fileStores} from "./durability/stores.ts";
import {type LaunchedProcess, launch} from "./launch/launch.ts";
import {compile} from "./ports/compile.ts";
import type {Graph} from "./ports/graph.ts";
import {open} from "./ports/wiring.ts";
import {Processes} from "./process/Processes.ts";
import {ProcessTable} from "./process/ProcessTable.ts";
import type {ProcessHandle} from "./process/process.ts";
import type {AnyProgram} from "./registry/program.ts";
import {Registry} from "./registry/Registry.ts";
import {ProcessTablePort} from "./table/ProcessTablePort.ts";

/** The global config module, `~/.tuval/tuval.config.ts`; the home dir is a parameter so a test can point it elsewhere. */
export const defaultGlobalConfig = (home: string = homedir()): string =>
	join(home, ".tuval", "tuval.config.ts");

/** A project's Tuval dir: its optional config module and, beside it, its checkpoints (gitignored). */
export const projectDir = (project: string): string => join(project, ".tuval");
export const projectConfig = (project: string): string =>
	join(projectDir(project), "tuval.config.ts");

export type Kernel =
	| Registry
	| Checkpoints
	| Processes
	| ProcessTable
	| ProcessTablePort
	| SpawnedProcesses
	| SpellSet
	| SpellRegistry
	| WindowIndex
	| SpellExecutor
	| SpellBridge;

/** The spells the kernel registers itself: discovery, then the three generic process tools. */
export const coreSpells: ReadonlyArray<AnySpell> = [...helpSpells, ...processSpells];

/** How long `process read` waits on a port that has said nothing yet before answering none. */
const READ_TIMEOUT = "1 second";

export interface StartOptions {
	readonly programs: ReadonlyArray<AnyProgram>;
	readonly graph: Graph;
	readonly stateDir: string;
	/**
	 * The config's key bindings, one source per layer, compiled against the registered spells.
	 * Absent for a caller that has no config layers to offer, which is every caller but `boot`.
	 */
	readonly keys?: ReadonlyArray<BindingSource>;
}

export interface Started {
	readonly kernel: Context.Context<Kernel>;
	/** The graph's processes, in node order. */
	readonly launched: ReadonlyArray<LaunchedProcess>;
	/** Checkpointed processes the graph did not plan, spawned back by `restore`. */
	readonly restored: ReadonlyArray<ProcessHandle>;
}

/**
 * The app from rows and a graph, built into the caller's Scope. The graph is compiled over the
 * registry before any process exists, so a bad route refuses here with nothing spawned and
 * nothing written; the wiring opens next and the kernel after it, so a stop takes the processes
 * down — pumps included — before their queues close. A snapshot under another definition
 * refuses the boot at its spawn, with nothing fresh-booted (#7467, #7514).
 */
export const start = Effect.fn("Tuval.start")(function* ({
	programs,
	graph,
	stateDir,
	keys,
}: StartOptions) {
	const registry = yield* Layer.build(Registry.layer(programs));
	const compiled = yield* compile(graph).pipe(Effect.provideContext(registry));
	const wiring = yield* open(compiled);
	const spells = yield* Layer.build(SpellSet.layer({core: coreSpells, programs, keys: keys ?? []}));
	// The bridge's allowlist is whoever builds the layer's, and no program row supplies one yet
	// (`.patterns/tuval-spells.md`, "The bridge"), so boot allows the whole registry as it stands.
	// A reload does not revisit it — #7743.
	const {table} = yield* Context.get(spells, SpellSet).read;
	const commands = Layer.mergeAll(
		SpellBridge.layer({allow: everyPath(table)}),
		SpawnedProcesses.layer({readTimeout: READ_TIMEOUT}),
	).pipe(
		Layer.provideMerge(SpellExecutor.layer),
		Layer.provideMerge(
			// No shell holds windows yet (#7499), so the index is empty: a call naming a window is
			// `NoSuchWindow`, and a call naming none is workspace-wide.
			Layer.mergeAll(Layer.succeedContext(spells), WindowIndex.scripted({})),
		),
	);
	const kernel = yield* Layer.build(
		Layer.mergeAll(ProcessTablePort.layer, commands).pipe(
			Layer.provideMerge(Processes.layer),
			Layer.provideMerge(Checkpoints.layer(fileStores(stateDir))),
			Layer.provideMerge(Layer.succeedContext(registry)),
		),
	);
	// The kernel rides into every launched process's handlers: the shell row's Cmds spawn programs
	// and read the process table, and a program row declares exactly those needs as its `R`.
	const launched = yield* launch(compiled, wiring, {services: kernel}).pipe(
		Effect.provideContext(kernel),
	);
	const restored = yield* restore.pipe(Effect.provideContext(kernel));
	return {kernel, launched, restored} satisfies Started;
});

export interface BootOptions {
	/** The global config module's path. */
	readonly global: string;
	/** The project directory; its `.tuval/` holds the project config and the state. */
	readonly project: string;
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
	readonly stateDir: string;
	readonly processCount: number;
	readonly restoredCount: number;
}

/** What a reload replaced. The running processes are not among them; see `Booted.reload`. */
export interface ReloadReport {
	readonly sources: ReadonlyArray<string>;
	readonly spellCount: number;
	readonly bindingCount: number;
	readonly bindingErrors: ReadonlyArray<BindingError>;
}

export interface Booted {
	readonly report: BootReport;
	readonly kernel: Context.Context<Kernel>;
	/**
	 * The config read again, its spells registered and its bindings compiled against them in one
	 * write. It replaces the spell registry and the binding table and nothing else: the processes
	 * the first boot launched keep running under the program rows they were spawned from.
	 */
	readonly reload: Effect.Effect<
		ReloadReport,
		ConfigLoadError | DuplicateSpellPath | SpellNotDescribable,
		FileSystem.FileSystem
	>;
}

/** `start` from the layered config: the `pnpm dev` path. */
export const boot = Effect.fn("Tuval.boot")(function* (options: BootOptions) {
	const layers = {global: options.global, project: projectConfig(options.project)};
	const config = yield* loadLayeredConfig(layers);
	// Config rows are trusted local code (#7484 R1.1); the loader checks each row's id, not its shape.
	const programs = config.programs as ReadonlyArray<AnyProgram>;
	const stateDir = projectDir(options.project);
	const started = yield* start({programs, graph: config.graph, stateDir, keys: config.keys});
	const live = yield* ProcessTable.use((table) => table.list).pipe(
		Effect.provideContext(started.kernel),
	);
	const spells = yield* SpellSet.use((set) => set.read).pipe(Effect.provideContext(started.kernel));
	const report: BootReport = {
		sources: config.sources,
		programCount: programs.length,
		spellCount: spells.table.rows.length,
		bindingCount: spells.bindings.bindings.length,
		bindingErrors: spells.bindings.errors,
		stateDir,
		processCount: live.length,
		restoredCount:
			started.launched.filter((process) => process.restored).length + started.restored.length,
	};

	const reload = Effect.fn("Tuval.reload")(function* () {
		const next = yield* loadLayeredConfig(layers);
		const set = yield* SpellSet;
		yield* set.reload({
			core: coreSpells,
			programs: next.programs as ReadonlyArray<AnyProgram>,
			keys: next.keys,
		});
		const current = yield* set.read;
		return {
			sources: next.sources,
			spellCount: current.table.rows.length,
			bindingCount: current.bindings.bindings.length,
			bindingErrors: current.bindings.errors,
		} satisfies ReloadReport;
	});

	return {
		report,
		kernel: started.kernel,
		reload: reload().pipe(Effect.provideContext(started.kernel)),
	} satisfies Booted;
});
