/**
 * `@kampus/tuval-shell` — the front door. One row factory and the types a config annotates it
 * with; `shellProgram` and the leaf beside it are here because the test drives the authored record
 * directly, and because a consumer that wants the status sentence or the output bound should read
 * the one this program uses rather than restate it.
 *
 * `./runner.ts`'s half is here for a different reason: `ShellRunner` is the seam a *caller* swaps.
 * `shell(options, runner)` takes a layer, so a test — or a host that wants commands somewhere other
 * than this machine — supplies one without reaching into the program.
 */

export {
	type Abandon,
	type Finished,
	type ShellCommand,
	startCommand,
} from "./run.ts";
export {
	RUN,
	type Run,
	type RunEvents,
	run,
	runHandler,
	ShellRunner,
	ShellRunnerLive,
} from "./runner.ts";
export {
	DEFAULT_ID,
	DEFAULT_SHELL,
	type ShellAuthored,
	type ShellOptions,
	type ShellPorts,
	type ShellUpdate,
	shell,
	shellProgram,
} from "./shell.ts";
export {
	basename,
	boundedTail,
	byteLength,
	COMMAND_HEAD,
	commandHead,
	droppedNote,
	OUTPUT_BYTE_LIMIT,
	type ShellEnding,
	type ShellRequest,
	type ShellRun,
	type ShellState,
	seconds,
	statusLine,
	succeeded,
	titleLine,
} from "./state.ts";
