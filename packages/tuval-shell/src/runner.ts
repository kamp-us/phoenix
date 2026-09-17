/**
 * The effect this program answers with, and the handler that performs it.
 *
 * **Subs observe, handlers perform** (#8716 R12.1). A command is *work* — it is started because a
 * cell decided to start it, it happens once, and it reports once — so it is a Cmd, not a
 * subscription. `shell` used to open the child inside a Demlik `DepKeyedSub` keyed on
 * `state.running`, which made the child a function of state rather than of a decision: the same
 * mechanism a timer is, doing the one thing a timer never does. The reducer now *asks* for the run
 * (`run({…})`) and the actor dispatches that ask to the handler below (#9295).
 *
 * **The actor dispatches on `type`.** `HostHandlers` is keyed by the Cmd's `type` field
 * (`@kampus/tuval`'s `registry/program.ts`), and the handler goes onto the compiled row by spread,
 * so the key here and the tag on the value are one string and it is named once: `RUN`.
 *
 * **The child is behind a service, not behind an import.** `ShellRunner` is what actually spawns;
 * `ShellRunnerLive` is `./run.ts` and `ShellRunner.context({start})` builds a fake. That is the
 * whole reason the seam exists: the handler — matching a request to its ending, answering exactly
 * one event — is testable without a process id, and `run.unit.test.ts` keeps the real children.
 *
 * **A built `Context`, never a `Layer`.** The difference is not cosmetic here: the handler is called
 * once per command, so a `Layer` handed to it is a `Layer` *built* once per command, and a
 * `Layer.scoped` runner — a pool, a connection, a remote executor — would be acquired and released
 * around every single run. A `Context` is already built, so there is nothing left to rebuild and
 * the mistake is unwritable. A caller whose runner needs acquisition builds its layer once under
 * its own Scope (`Layer.build`) and hands the `Context` that comes out.
 *
 * **The handler always answers.** A run that never reports leaves `state.running` set for the life
 * of the process: the tile says `running …` for ever, every later prompt is refused as busy, and
 * the caller waiting on `result` is hung. So a defect — `spawn` throwing synchronously on a command
 * holding a NUL byte, a runner with a bug in it — is turned into a `Finished` with no exit code,
 * which `endingOf` already reads as `killed` and which the async spawn failure path has always
 * produced (`./run.ts`'s `child.on("error")`). The state machine is the thing being protected, and
 * it only has one way to hear that a run is over.
 *
 * **Cancellation lives in the Effect.** `startCommand` hands back an abandon, and it is the
 * `Effect.callback` finalizer, so an interrupted handler kills the child's process group rather
 * than leaving it up. *How much that covers is the actor's to decide, not this file's:* the
 * finalizer runs when the Scope the handler was forked into is closed, which is the
 * `dispatchUnawaited` path. On the `dispatchOnce` path the actor drains and waits on the child, so
 * there is nothing to interrupt and the finalizer is a no-op. That the actor takes the second path
 * under its single-permit semaphore is what kamp-us/phoenix#9297 is about.
 */

import {Context, Effect} from "effect";
import {type Finished, type ShellCommand, startCommand} from "./run.ts";

/**
 * The effect's tag, and therefore the key its handler takes on the row. Namespaced because the
 * `handlers` record is shared with the six kernel effects and a bare `run` would be this package
 * claiming a word it does not own.
 */
export const RUN = "shell/run" as const;

/**
 * "Run this." Plain data and nothing else — every field was decided by the config or by the prompt,
 * so a cell that answers one has read a clock, opened nothing and held no handle.
 */
export interface Run extends ShellCommand {
	readonly type: typeof RUN;
}

/** The constructor a cell writes: `run({key, command, cwd, shell, timeoutMs, env})`. */
export const run = (command: ShellCommand): Run => ({type: RUN, ...command});

/** The one event the handler answers with: the run, over. `./shell.ts`'s `finished` cell reads it. */
export type RunEvents = ReadonlyArray<Finished>;

/**
 * Whatever actually runs a command. One method, because there is one thing to do: start this and
 * resolve when it is over. Interrupting the Effect abandons the run.
 */
export class ShellRunner extends Context.Service<
	ShellRunner,
	{
		readonly start: (command: ShellCommand) => Effect.Effect<Finished>;
	}
>()("@kampus/tuval-shell/ShellRunner") {}

/**
 * The real child, as an Effect: `./run.ts`'s callback shape with its abandon hung on the Scope. The
 * report happens once by `startCommand`'s own rule, so the `resume` below is called once.
 */
const spawnChild = (command: ShellCommand): Effect.Effect<Finished> =>
	Effect.callback<Finished>((resume) => {
		const abandon = startCommand(command, (finished) => resume(Effect.succeed(finished)));
		return Effect.sync(abandon);
	});

/** The runner a shipped `shell(...)` uses: a detached process group, group-killed on a timeout. */
export const ShellRunnerLive: Context.Context<ShellRunner> = ShellRunner.context({
	start: spawnChild,
});

/** What a run that died before it could report says: a failed run, no exit code, the reason as its output. */
const died = (command: ShellCommand, cause: unknown): Finished => ({
	type: "finished",
	key: command.key,
	code: null,
	output: `${cause instanceof Error ? cause.message : String(cause)}\n`,
	timedOut: false,
	durationMs: 0,
});

/**
 * The handler, over a runner that is already built.
 *
 * The service is read *here*, when the row is assembled, and the returned function closes over it:
 * one lookup for the life of the program rather than one per command. It takes a `Context` rather
 * than declaring `ShellRunner` as a leftover requirement because the kernel builds the services a
 * row's handlers run on and this one is not the kernel's to know about — the program brings its own.
 *
 * It answers a *list*, which is what a `HostHandlers` handler owes: one `finished`, fed back into
 * the program's own inbox as an ordinary event. `catchDefect` is what makes "a list" unconditional:
 * see the note on the handler always answering at the top of this file. An interruption is not a
 * defect and is deliberately not caught — an abandoned run is one nobody is waiting for.
 */
export const runHandler = (services: Context.Context<ShellRunner> = ShellRunnerLive) => {
	const runner = Context.get(services, ShellRunner);
	return (effect: Run): Effect.Effect<RunEvents> =>
		Effect.suspend(() => runner.start(effect)).pipe(
			Effect.catchDefect((defect) => Effect.succeed(died(effect, defect))),
			Effect.map((finished) => [finished]),
		);
};
