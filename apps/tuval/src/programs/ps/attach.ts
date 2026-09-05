/**
 * How Enter on a row puts that process in a window: one spell call on the shell's existing attach
 * path, and nothing else.
 *
 * This program builds no window binding of its own (#7692 R1.2). `window:attach` is the shell's own
 * command — declared with the picker's grammar in `../../shell/picker/intent.ts`, lifted into the
 * command table, and published as a spell under the shell's program id — so a row's Enter and the
 * command line's `:attach <process-id>` end in the same handler. Reaching into the shell's window
 * state instead would put window ownership in this epic, which is #7499's.
 *
 * The path is spelled out rather than imported from `../../shell/program.ts` for the reason
 * `../../shell/transport/client.ts` spells `SHELL_PROGRAM_ID` out: this module is on the page's
 * import graph, and importing the shell's row would drag the kernel-side shell — its machine, its
 * effects, its graph node — into the browser bundle behind it. `attach.unit.test.ts` reads the real
 * shell spell list back and fails if this literal stops naming a spell that exists.
 */

import type {SpellPath} from "../../commands/spell.ts";
import type {ProcessId} from "../../protocol/ids.ts";

/** `[<program id>, ...<spell path>]`, the address the spell registry keys a program's spell under. */
export const ATTACH_SPELL_PATH: SpellPath = ["shell", "window", "attach"];

/** The `window:attach` row's one parameter, by the name its `Schema.Struct` declares. */
export interface AttachArgs {
	readonly process: string;
}

/**
 * Whoever can put a spell call on the wire. The page supplies the socket-backed one; a test supplies
 * a double and reads back what the table asked for. `void` rather than an Effect because the whole
 * program is a React renderer: the caller owns the runtime, and a row press is fire-and-forget —
 * the answer arrives as the next `Snapshot`, not as a return value.
 */
export interface SpellCaller {
	readonly call: (path: SpellPath, args: unknown) => void;
}

export const attachArgs = (processId: ProcessId): AttachArgs => ({process: String(processId)});

/** Attach this process to the focused window. One call, one process id, no second effect. */
export const callAttach = (caller: SpellCaller, processId: ProcessId): void =>
	caller.call(ATTACH_SPELL_PATH, attachArgs(processId));
