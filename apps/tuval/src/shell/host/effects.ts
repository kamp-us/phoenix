/**
 * The shell's Cmds, run against the kernel. `unwiredShellEffects` (`../program.ts`) drops all eight;
 * this is the set that does the work, and it is what `.tuval/tuval.config.ts` registers the shell
 * row with.
 *
 * The services these handlers need — `Registry`, `Processes`, `ProcessTable` — arrive as the row's
 * own `R`. Nothing here reaches for a module-level kernel: `launch` hands every planned process the
 * kernel context beside its `ProcessPorts` (`../../launch/launch.ts`), which is the one seam a
 * program row's requirements can be satisfied through.
 *
 * Three of the eight stay inert here, and each for a stated reason rather than a shrug. The two
 * prefix-timer Cmds belong to whoever is showing the desk: a kernel handler returns its follow-ups
 * and cannot dispatch one a second later, and the snapshot already carries the armed window's
 * length, so the surface runs the countdown off state alone (`../ui/Desk.tsx`). `openCommandLine` is
 * the same shape — the line is a page's own element, not a process. `reloadConfig` is the one that
 * is simply not built: `Booted.reload` lives above the kernel, out of a handler's reach, and #7743
 * tracks it.
 */

import {Effect, Option} from "effect";
import {Processes} from "../../process/Processes.ts";
import type {ProcessTable} from "../../process/ProcessTable.ts";
import {ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";
import type {Registry} from "../../registry/Registry.ts";
import {attachProcess, openProgram, runPickerIntent} from "../picker/index.ts";
import type {ShellEffects} from "../program.ts";
import {WindowId} from "../window/index.ts";

export interface WiredShellOptions {
	/**
	 * The shell's own process id — the parent every program the picker opens is spawned under. A
	 * handler is not told which process it runs in, and the shell is spawned at its graph node's id
	 * (`launch` spawns each node at its own id), so the config that plans that node states it here.
	 */
	readonly shellProcessId: ProcessId;
}

/** What the handlers need from the kernel. Declared once so the row's `R` and this list agree. */
export type ShellHostServices = Registry | Processes | ProcessTable;

/**
 * A key belongs to the focused window's process, so it is delivered as that program's own `key` Msg
 * (`../../demo/log.ts` shows the cell). Everything about the delivery is best-effort: a process that
 * has stopped, or one whose core has no `key` cell, drops the key at debug rather than failing the
 * shell — the shell's error channel is `never` and a keystroke is not worth ending a desk over.
 */
const forwardKey = (processId: string, key: string) =>
	Effect.gen(function* () {
		const processes = yield* Processes;
		const handle = yield* processes.handle(ProcessId.make(processId));
		if (Option.isNone(handle)) {
			return yield* Effect.logDebug(`shell: forwardKey "${key}" — process ${processId} is gone`);
		}
		yield* handle.value
			.dispatch({type: "key", key})
			.pipe(
				Effect.catchCause(() =>
					Effect.logDebug(`shell: forwardKey "${key}" refused by process ${processId}`),
				),
			);
	});

export const wiredShellEffects = ({
	shellProcessId,
}: WiredShellOptions): ShellEffects<never, ShellHostServices> => ({
	forwardKey: (cmd) => Effect.as(forwardKey(cmd.processId, cmd.key), []),
	startPrefixTimer: () => Effect.succeed([]),
	cancelPrefixTimer: () => Effect.succeed([]),
	openCommandLine: () => Effect.succeed([]),
	runCommand: (cmd) =>
		Effect.as(
			Effect.logDebug(`shell: runCommand "${cmd.name}" names no command row — dropped`),
			[],
		),
	reloadConfig: () =>
		Effect.as(
			Effect.logDebug("shell: config:reload is not wired to the config loader (#7743)"),
			[],
		),
	openProgram: (cmd) =>
		runPickerIntent(openProgram(WindowId.make(cmd.windowId), ProgramId.make(cmd.programId)), {
			shellProcessId,
		}),
	attachProcess: (cmd) =>
		runPickerIntent(attachProcess(WindowId.make(cmd.windowId), ProcessId.make(cmd.processId)), {
			shellProcessId,
		}),
});
