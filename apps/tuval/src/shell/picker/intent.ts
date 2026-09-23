/**
 * The one thing a user can ask an empty window for, whichever way they ask it: open a program, or
 * attach to a process already running. Choosing a picker row produces an intent and so does the
 * command line — `runPickerIntent` is the single place either one ends, which is what keeps the two
 * routes from drifting into two spawn paths.
 *
 * The two command rows are declared here rather than in `../commands/` (#7555) so the argument
 * grammar sits beside the handler that consumes it; the commands slice folds `pickerCommands` into
 * its table and owns the command line itself, which is why no line reader lives here.
 */

import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import type {WindowId} from "@kampus/tuval-sdk/kernel/shell/window/host";
import {CommandName} from "@kampus/tuval-ui/keys";
import type {PickerEntry} from "./entries.ts";

/**
 * The session a spawn is for, when it is for one. Exactly `{cwd, resume}` and never a third field:
 * the epic's rabbit-holes (#8070) rule out growing `Processes.spawn` into a program-arguments
 * system, so this rides one narrow slot the spawner turns into a `SessionOpening` service
 * (`../../ai-agent/opening.ts`) and nothing else reads.
 */
export interface ProgramOpening {
	readonly cwd: string;
	readonly resume: string | null;
}

export type PickerIntent =
	| {
			readonly _tag: "OpenProgram";
			readonly windowId: WindowId;
			readonly programId: ProgramId;
			/** Absent leaves the program to choose its own opening; present fixes its cwd and optional resume. */
			readonly opening?: ProgramOpening;
	  }
	| {readonly _tag: "AttachProcess"; readonly windowId: WindowId; readonly processId: ProcessId};

export const openProgram = (
	windowId: WindowId,
	programId: ProgramId,
	opening?: ProgramOpening,
): PickerIntent => ({
	_tag: "OpenProgram",
	windowId,
	programId,
	...(opening === undefined ? {} : {opening}),
});

export const attachProcess = (windowId: WindowId, processId: ProcessId): PickerIntent => ({
	_tag: "AttachProcess",
	windowId,
	processId,
});

/** The intent a highlighted row commits to. The two entry kinds are the two intents, one to one. */
export const intentOf = (windowId: WindowId, entry: PickerEntry): PickerIntent =>
	entry._tag === "Program"
		? openProgram(windowId, entry.programId)
		: attachProcess(windowId, entry.processId);

export const OPEN_COMMAND: CommandName = CommandName.make("window:open");
export const ATTACH_COMMAND: CommandName = CommandName.make("window:attach");

/**
 * One command row's shape as far as this slice defines it: the name the prefix table binds, the
 * argument it takes, and how the pair becomes an intent. `argument` is what a completion surface
 * offers against — the program list for `open`, the process list for `attach`.
 */
export interface PickerCommand {
	readonly name: CommandName;
	readonly argument: "program-id" | "process-id";
	readonly summary: string;
	readonly toIntent: (windowId: WindowId, argument: string) => PickerIntent;
}

export const pickerCommands: ReadonlyArray<PickerCommand> = [
	{
		name: OPEN_COMMAND,
		argument: "program-id",
		summary: "Spawn a program and show it in this window.",
		toIntent: (windowId, argument) => openProgram(windowId, ProgramId.make(argument)),
	},
	{
		name: ATTACH_COMMAND,
		argument: "process-id",
		summary: "Show a running process in this window.",
		toIntent: (windowId, argument) => attachProcess(windowId, ProcessId.make(argument)),
	},
];

const byName = new Map(pickerCommands.map((command) => [command.name as string, command]));

export const pickerCommandFor = (name: CommandName): PickerCommand | undefined =>
	byName.get(name as string);
