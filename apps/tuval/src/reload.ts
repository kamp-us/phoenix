/**
 * A config reload: read the config again, swap the spell registry and key bindings in one write,
 * then bring every live process up to the rows it just read. Running processes move to the new code
 * and keep their state: a process whose row's code changed, in the row's own functions or in an
 * author file they stand on, is switched onto the reloaded row under the same id (#9820, the
 * founder's ruling recorded on that issue; #9822). Every process is then handed the Msgs its own
 * row says the re-read config means for it (`registry/program.ts`'s `configChanged`, #7509
 * ruling 3).
 *
 * It sits beside `boot.ts` rather than in either slice because it is the one place the two
 * generations of program rows meet: the reloader holds the config it just read, and the processes
 * it walks were spawned from the one before it. The `Registry` is not that pair — it still holds
 * the boot generation after any number of reloads, which is exactly why the running generation is
 * carried in the reloader's own `Ref` instead.
 *
 * A swap or dispatch that fails is logged and the walk goes on: a reload is a read of the config,
 * and one process refusing it must not turn it into a refusal of the whole re-read.
 */

import type {BindingError} from "@kampus/tuval-sdk/kernel/commands/bindings/index";
import {DuplicateSpellPath, SpellNotDescribable} from "@kampus/tuval-sdk/kernel/commands/errors";
import type {AnySpell} from "@kampus/tuval-sdk/kernel/commands/spell";
import {SpellSet} from "@kampus/tuval-sdk/kernel/commands/spell-set";
import {Processes, type SwapOutcome} from "@kampus/tuval-sdk/kernel/process/Processes";
import {ProcessTable} from "@kampus/tuval-sdk/kernel/process/ProcessTable";
import type {Message, ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {ProcessSelf} from "@kampus/tuval-sdk/kernel/process/self";
import type {AnyProgram, ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {Context, Effect, Layer, Option, Ref, Schema, Semaphore} from "effect";
import {AuthoredModules} from "./authored-modules.ts";
import {ConfigLoadError, type ProjectLayer} from "./config.ts";
import type {ConfigGeneration} from "./config-generation.ts";

const byId = (rows: ReadonlyArray<AnyProgram>): ReadonlyMap<ProgramId, AnyProgram> =>
	new Map(rows.map((row) => [row.id, row]));

const sourceOf = (value: unknown, seen: Set<object>, functions: Set<string>): string => {
	if (typeof value === "function") {
		const text = value.toString();
		functions.add(text);
		return text;
	}
	// A primitive leaf is part of the row's text too: the version, and every migration's `to`.
	if (typeof value !== "object" || value === null) return `${typeof value}:${String(value)}`;
	if (seen.has(value)) return "";
	seen.add(value);
	return Object.entries(value)
		.map(([key, field]) => `${key}(${sourceOf(field, seen, functions)})`)
		.join();
};

/**
 * The source text of everything on a row that runs, beside the version its state is written under,
 * and the source of every author file that code stands on. Every module the config imports by path
 * is evaluated again on each read, so a row's functions are new objects whether or not anyone edited
 * them; their text is what an edit to them moves. A helper they call is not in their text, so
 * `modules` adds each file that defines one of the row's functions and every file that one imports
 * by path, transitively, as the load read them: an edit confined to such a helper moves the answer
 * too. A value a function closes over is config rather than code, and reaches a running process
 * through `configChanged`.
 */
export const codeOf = (
	row: AnyProgram,
	modules: AuthoredModules = AuthoredModules.none,
): string => {
	const functions = new Set<string>();
	const own = sourceOf(
		[
			row.identity.version,
			row.core,
			row.handlers,
			row.subs,
			row.receive,
			row.resume,
			row.derivedLines,
			row.configChanged,
			row.restorable,
			row.migrations,
			row.checkpointWorthy,
		],
		new Set(),
		functions,
	);
	return `${own}|${modules.sourceBehind(functions)}`;
};

/** One read of the config's rows, beside the author's modules they were built from. */
export interface ProgramGeneration {
	readonly programs: ReadonlyArray<AnyProgram>;
	readonly modules: AuthoredModules;
}

/** Rows no config load stands behind, as a kernel started from rows holds them. */
export const rowsOnly = (programs: ReadonlyArray<AnyProgram>): ProgramGeneration => ({
	programs,
	modules: AuthoredModules.none,
});

/** What a reload did to the live processes, which `ReloadReport` carries. */
export interface Applied {
	readonly notified: number;
	readonly switched: ReadonlyArray<ProcessId>;
	readonly restoreRefused: ReadonlyArray<ProcessId>;
	readonly pending: ReadonlyArray<ProcessId>;
}

const swapLine = (id: ProcessId, outcome: SwapOutcome): string =>
	outcome === "switched"
		? `tuval: process "${id}" switched to its reloaded code`
		: `tuval: process "${id}" switched to its reloaded code, which refused its state`;

/**
 * Brings every live process up to the reloaded rows: a changed row's processes are switched onto
 * it, then every process is handed its row's `configChanged` Msgs. A process whose row the reloaded
 * config dropped is left running and untold.
 */
export const applyReload = (
	previous: ProgramGeneration,
	next: ProgramGeneration,
): Effect.Effect<Applied, never, ProcessTable | Processes> =>
	Effect.gen(function* () {
		const table = yield* ProcessTable;
		const processes = yield* Processes;
		// The process whose own handler is running this reload, when a key asked for it.
		const self = yield* Effect.serviceOption(ProcessSelf);
		const running = byId(previous.programs);
		const reloaded = byId(next.programs);
		let notified = 0;
		const switched: Array<ProcessId> = [];
		const restoreRefused: Array<ProcessId> = [];
		const pending: Array<ProcessId> = [];
		for (const row of yield* table.list) {
			const spawnedFrom = running.get(row.programId);
			const replacement = reloaded.get(row.programId);
			if (spawnedFrom === undefined || replacement === undefined) continue;
			if (codeOf(spawnedFrom, previous.modules) !== codeOf(replacement, next.modules)) {
				const swap = processes.swap(row.id, replacement);
				if (Option.isSome(self) && self.value.id === row.id) {
					// A swap waits for the fold in flight, and here that fold is the one running this
					// reload: it goes after the fold, on the process's own Scope, and logs for itself.
					yield* Effect.forkIn(
						swap.pipe(
							Effect.flatMap((outcome) => Effect.logInfo(swapLine(row.id, outcome))),
							Effect.catch((error) => Effect.logError(error)),
						),
						self.value.scope,
					);
					pending.push(row.id);
				} else {
					const outcome = yield* swap.pipe(
						Effect.map(Option.some),
						Effect.catch((error) => Effect.as(Effect.logError(error), Option.none())),
					);
					if (Option.isSome(outcome)) {
						(outcome.value === "switched" ? switched : restoreRefused).push(row.id);
					}
				}
			}
			if (spawnedFrom.configChanged === undefined) continue;
			const messages = spawnedFrom.configChanged(replacement) as ReadonlyArray<Message>;
			if (messages.length === 0) continue;
			const handle = yield* processes.handle(row.id);
			if (Option.isNone(handle)) continue;
			// Serial: a row's answer is an ordered list, and dispatching it in parallel would apply
			// two of one process's Msgs in whichever order the fibers happened to win.
			yield* Effect.forEach(messages, handle.value.dispatch, {
				concurrency: 1,
				discard: true,
			}).pipe(Effect.catch((error) => Effect.logError(error)));
			notified += 1;
		}
		return {notified, switched, restoreRefused, pending} satisfies Applied;
	}).pipe(Effect.withSpan("Tuval.reload.applyReload"));

/** Refused by a kernel `start` was handed rows rather than a config to read them from. */
export class NoConfigToReload extends Schema.TaggedError<NoConfigToReload>()(
	"tuval/NoConfigToReload",
	{},
) {
	override get message(): string {
		return "this kernel was started from rows, not from a config, so there is nothing to read again";
	}
}

export type ReloadError =
	| ConfigLoadError
	| DuplicateSpellPath
	| SpellNotDescribable
	| NoConfigToReload;

/**
 * A reload that refused, beside every file its read imported. The desk stays on the generation it
 * was running, and a watcher adds these files to the ones it watches: the file that broke the reload
 * may be one only the refused config imports.
 */
export class ReloadRefused extends Schema.TaggedError<ReloadRefused>()("tuval/ReloadRefused", {
	reason: Schema.Union([
		ConfigLoadError,
		DuplicateSpellPath,
		SpellNotDescribable,
		NoConfigToReload,
	]),
	files: Schema.Array(Schema.String),
}) {
	override get message(): string {
		return this.reason.message;
	}
}

/** What a reload replaced, and what it did to the running processes. */
export interface ReloadReport {
	readonly sources: ReadonlyArray<string>;
	readonly files: ReadonlyArray<string>;
	readonly spellCount: number;
	readonly bindingCount: number;
	readonly bindingErrors: ReadonlyArray<BindingError>;
	/**
	 * Live processes handed a config change by their own row's `configChanged`. A row whose
	 * settings did not move, one that applies nothing live, and one the reloaded config dropped
	 * all leave their processes uncounted and untouched.
	 */
	readonly notified: number;
	/** Live processes now running their reloaded row's code over the state they had. */
	readonly switched: ReadonlyArray<ProcessId>;
	/**
	 * Live processes moved onto their reloaded row, whose `migrations` or `restorable` refused the
	 * state they carried: each sits in that program's own refused-restore state.
	 */
	readonly restoreRefused: ReadonlyArray<ProcessId>;
	/**
	 * The process whose own handler ran this reload, when its row changed. Its swap runs once that
	 * handler has finished, and logs its own outcome.
	 */
	readonly pending: ReadonlyArray<ProcessId>;
}

/** The processes a reload moved, as the tail of the line a desk logs for it; empty when none moved. */
export const describeSwaps = (report: ReloadReport): string =>
	(
		[
			["switched", report.switched],
			["restore refused", report.restoreRefused],
			["switching once its own key is handled", report.pending],
		] as const
	)
		.filter(([, ids]) => ids.length > 0)
		.map(([label, ids]) => `, ${label}: ${ids.join(" ")}`)
		.join("");

export interface FromConfigOptions {
	/** The kernel's own spells, registered beside every reloaded row's. */
	readonly core: ReadonlyArray<AnySpell>;
	/** The generation the kernel was started with, so the first reload diffs against it. */
	readonly initial: ConfigGeneration;
	/**
	 * How to read the config again, given the projects open when the reload runs. Absent for a kernel
	 * handed rows and no config, and that kernel's reload refuses with `NoConfigToReload`.
	 */
	readonly read?: (
		projects: ReadonlyArray<ProjectLayer>,
	) => Effect.Effect<ConfigGeneration, ConfigLoadError>;
}

/**
 * The reload as a kernel service, so the shell's `config:reload` handler reaches it like any other
 * `R`. Running processes move to the new code and keep their state: a process whose row's code
 * changed is switched onto the reloaded row under the same id, and one whose row did not is left
 * running and handed only what its row's `configChanged` answers. A refused reload switches nothing,
 * because the read and the registry swap both come first. Reloads run one at a time, because each
 * swaps the generation the live processes are diffed against.
 *
 * `swap` is the other writer of that generation: a project opening or closing (#9685) moves whole
 * rows in or out, and no live process runs under a row either one changes, so it tells none. It
 * holds the same lock, so a reload never reads the open projects halfway through one.
 */
export class ConfigReloader extends Context.Service<
	ConfigReloader,
	{
		readonly reload: Effect.Effect<ReloadReport, ReloadRefused>;
		readonly swap: <E>(
			next: (current: ConfigGeneration) => Effect.Effect<ConfigGeneration, E>,
		) => Effect.Effect<void, E | ReloadRefused>;
	}
>()("tuval/ConfigReloader") {
	static readonly fromConfig = ({
		core,
		initial,
		read,
	}: FromConfigOptions): Layer.Layer<ConfigReloader, never, SpellSet | ProcessTable | Processes> =>
		Layer.effect(
			ConfigReloader,
			Effect.gen(function* () {
				const services = yield* Effect.context<ProcessTable | Processes>();
				const set = yield* SpellSet;
				const generation = yield* Ref.make(initial);
				const lock = yield* Semaphore.make(1);
				const install = (next: ConfigGeneration) =>
					set
						.reload({core, programs: next.programs, keys: next.keys})
						.pipe(Effect.mapError((reason) => new ReloadRefused({reason, files: next.files})));
				const reload = Effect.gen(function* () {
					if (read === undefined) {
						return yield* new ReloadRefused({reason: new NoConfigToReload(), files: []});
					}
					const next = yield* read((yield* Ref.get(generation)).projects).pipe(
						Effect.mapError((reason) => new ReloadRefused({reason, files: reason.files})),
					);
					yield* install(next);
					const applied = yield* applyReload(yield* Ref.getAndSet(generation, next), next).pipe(
						Effect.provideContext(services),
					);
					const current = yield* set.read;
					return {
						sources: next.sources,
						files: next.files,
						spellCount: current.table.rows.length,
						bindingCount: current.bindings.bindings.length,
						bindingErrors: current.bindings.errors,
						...applied,
					} satisfies ReloadReport;
				}).pipe(lock.withPermits(1), Effect.withSpan("Tuval.reload"));
				const swap = <E>(
					next: (current: ConfigGeneration) => Effect.Effect<ConfigGeneration, E>,
				): Effect.Effect<void, E | ReloadRefused> =>
					Effect.gen(function* () {
						const swapped = yield* next(yield* Ref.get(generation));
						yield* install(swapped);
						yield* Ref.set(generation, swapped);
					}).pipe(lock.withPermits(1), Effect.withSpan("Tuval.reload.swap"));
				return ConfigReloader.of({reload, swap});
			}),
		);

	/** A kernel started from rows: every reload refuses, naming why. */
	static readonly none: Layer.Layer<ConfigReloader> = Layer.succeed(
		ConfigReloader,
		ConfigReloader.of({
			reload: Effect.fail(new ReloadRefused({reason: new NoConfigToReload(), files: []})),
			swap: () => Effect.fail(new ReloadRefused({reason: new NoConfigToReload(), files: []})),
		}),
	);
}
