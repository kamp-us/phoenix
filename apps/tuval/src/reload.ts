/**
 * A config reload: read the config again, swap the spell registry and key bindings in one write,
 * and hand every live process the Msgs its own row says the re-read config means for it
 * (`registry/program.ts`'s `configChanged`, #7509 ruling 3).
 *
 * It sits beside `boot.ts` rather than in either slice because it is the one place the two
 * generations of program rows meet: the reloader holds the config it just read, and the processes
 * it walks were spawned from the one before it. The `Registry` is not that pair — it still holds
 * the boot generation after any number of reloads, which is exactly why the running generation is
 * carried in the reloader's own `Ref` instead.
 *
 * A dispatch that fails is logged and the walk goes on: a reload is a read of the config, and one
 * process refusing a Msg must not turn it into a refusal of the whole re-read.
 */

import type {BindingError, BindingSource} from "@kampus/tuval-sdk/kernel/commands/bindings/index";
import type {
	DuplicateSpellPath,
	SpellNotDescribable,
} from "@kampus/tuval-sdk/kernel/commands/errors";
import type {AnySpell} from "@kampus/tuval-sdk/kernel/commands/spell";
import {SpellSet} from "@kampus/tuval-sdk/kernel/commands/spell-set";
import {Processes} from "@kampus/tuval-sdk/kernel/process/Processes";
import {ProcessTable} from "@kampus/tuval-sdk/kernel/process/ProcessTable";
import type {Message} from "@kampus/tuval-sdk/kernel/process/process";
import type {AnyProgram, ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {Context, Effect, Layer, Option, Ref, Schema, Semaphore} from "effect";
import type {ConfigLoadError} from "./config.ts";

const byId = (rows: ReadonlyArray<AnyProgram>): ReadonlyMap<ProgramId, AnyProgram> =>
	new Map(rows.map((row) => [row.id, row]));

/**
 * Answers how many live processes were handed a change, which is what `ReloadReport` carries: a
 * reload that moved no row a process is running under answers zero.
 */
export const dispatchConfigChanged = (
	previous: ReadonlyArray<AnyProgram>,
	next: ReadonlyArray<AnyProgram>,
): Effect.Effect<number, never, ProcessTable | Processes> =>
	Effect.gen(function* () {
		const table = yield* ProcessTable;
		const processes = yield* Processes;
		const running = byId(previous);
		const reloaded = byId(next);
		let notified = 0;
		for (const row of yield* table.list) {
			const spawnedFrom = running.get(row.programId);
			const replacement = reloaded.get(row.programId);
			if (spawnedFrom?.configChanged === undefined || replacement === undefined) continue;
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
		return notified;
	}).pipe(Effect.withSpan("Tuval.reload.dispatchConfigChanged"));

/** One read of the config, as `boot` runs it: the rows with their flags applied, and their keys. */
export interface ConfigRead {
	readonly programs: ReadonlyArray<AnyProgram>;
	readonly keys: ReadonlyArray<BindingSource>;
	/** The layer modules that existed, global first. */
	readonly sources: ReadonlyArray<string>;
	/** Every file the read imported the config from (`LoadedConfig.files`). */
	readonly files: ReadonlyArray<string>;
}

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

/** What a reload replaced, and how many running processes it told. */
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
}

export interface FromConfigOptions {
	/** The kernel's own spells, registered beside every reloaded row's. */
	readonly core: ReadonlyArray<AnySpell>;
	/** The generation the kernel was started with, so the first reload diffs against it. */
	readonly initial: ReadonlyArray<AnyProgram>;
	readonly read: Effect.Effect<ConfigRead, ConfigLoadError>;
}

/**
 * The reload as a kernel service, so the shell's `config:reload` handler reaches it like any other
 * `R`. Nothing restarts and nothing respawns: a process keeps running under the row it was spawned
 * from, and what applies live is the row's own call. Reloads run one at a time, because each swaps
 * the generation the live processes are diffed against.
 */
export class ConfigReloader extends Context.Service<
	ConfigReloader,
	{readonly reload: Effect.Effect<ReloadReport, ReloadError>}
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
				const reload = Effect.gen(function* () {
					const next = yield* read;
					yield* set.reload({core, programs: next.programs, keys: next.keys});
					const notified = yield* dispatchConfigChanged(
						yield* Ref.getAndSet(generation, next.programs),
						next.programs,
					).pipe(Effect.provideContext(services));
					const current = yield* set.read;
					return {
						sources: next.sources,
						files: next.files,
						spellCount: current.table.rows.length,
						bindingCount: current.bindings.bindings.length,
						bindingErrors: current.bindings.errors,
						notified,
					} satisfies ReloadReport;
				}).pipe(lock.withPermits(1), Effect.withSpan("Tuval.reload"));
				return ConfigReloader.of({reload});
			}),
		);

	/** A kernel started from rows: every reload refuses, naming why. */
	static readonly none: Layer.Layer<ConfigReloader> = Layer.succeed(
		ConfigReloader,
		ConfigReloader.of({reload: Effect.fail(new NoConfigToReload())}),
	);
}
