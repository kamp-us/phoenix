import {homedir} from "node:os";
import {join} from "node:path";
import {type Context, Effect, Layer} from "effect";
import {loadLayeredConfig} from "./config.ts";
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

export type Kernel = Registry | Checkpoints | Processes | ProcessTable | ProcessTablePort;

export interface StartOptions {
	readonly programs: ReadonlyArray<AnyProgram>;
	readonly graph: Graph;
	readonly stateDir: string;
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
}: StartOptions) {
	const registry = yield* Layer.build(Registry.layer(programs));
	const compiled = yield* compile(graph).pipe(Effect.provideContext(registry));
	const wiring = yield* open(compiled);
	const kernel = yield* Layer.build(
		ProcessTablePort.layer.pipe(
			Layer.provideMerge(Processes.layer),
			Layer.provideMerge(Checkpoints.layer(fileStores(stateDir))),
			Layer.provideMerge(Layer.succeedContext(registry)),
		),
	);
	const launched = yield* launch(compiled, wiring).pipe(Effect.provideContext(kernel));
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
	readonly stateDir: string;
	readonly processCount: number;
	readonly restoredCount: number;
}

export interface Booted {
	readonly report: BootReport;
	readonly kernel: Context.Context<Kernel>;
}

/** `start` from the layered config: the `pnpm dev` path. */
export const boot = Effect.fn("Tuval.boot")(function* (options: BootOptions) {
	const config = yield* loadLayeredConfig({
		global: options.global,
		project: projectConfig(options.project),
	});
	// Config rows are trusted local code (#7484 R1.1); the loader checks each row's id, not its shape.
	const programs = config.programs as ReadonlyArray<AnyProgram>;
	const stateDir = projectDir(options.project);
	const started = yield* start({programs, graph: config.graph, stateDir});
	const live = yield* ProcessTable.use((table) => table.list).pipe(
		Effect.provideContext(started.kernel),
	);
	const report: BootReport = {
		sources: config.sources,
		programCount: programs.length,
		stateDir,
		processCount: live.length,
		restoredCount:
			started.launched.filter((process) => process.restored).length + started.restored.length,
	};
	return {report, kernel: started.kernel} satisfies Booted;
});
