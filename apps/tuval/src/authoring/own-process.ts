/**
 * Which process a command's bare `send("pr", pr)` lands on (#8898, founder ruling 2026-09-10:
 * <https://github.com/kamp-us/phoenix/issues/8898#issuecomment-5625301070>).
 *
 * A command runs under a `Scope` (`../commands/spell.ts`) whose `process` is the *caller's* — the
 * process behind the window the call came from — so the declaring program's own process is not
 * something the call carries. It is looked up here, against the live set, by the one thing the
 * command does name: the program that declared it.
 *
 * The rule, in full, and it is the whole of the ruling:
 *
 * 1. Exactly one live process of that program — that one.
 * 2. Several, and the caller's own process is among them — the caller's.
 * 3. Anything else — a refusal naming the program and what was ambiguous about it.
 *
 * Case 3 is a typed failure of the command's spell, so it comes back as a spell reply the caller
 * reads (`../commands/executor.ts`) rather than as a silent no-op. Nothing here picks a process by
 * recency, focus or luck: a program with several processes and no caller among them has no honest
 * answer, so it gets none.
 *
 * `ProcessTable` is the read, and it is read rather than `SpawnedProcesses` because the question is
 * "which processes of this program are alive", which only the table answers. `Kernel`
 * (`../boot.ts`) already names it, so this adds nothing to what the composition root owes.
 */

import {Effect, Schema} from "effect";
import type {Scope} from "../commands/spell.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import {ProcessId} from "../process/process.ts";
import {ProgramId} from "../registry/program.ts";

/** No process of the declaring program is running, so its in-ports are nobody's to write to yet. */
export class NoLiveProcess extends Schema.TaggedError<NoLiveProcess>()(
	"tuval/authoring/NoLiveProcess",
	{program: ProgramId, port: Schema.String},
) {
	override get message(): string {
		return `no live process of program "${this.program}" to send "${this.port}" to`;
	}
}

/**
 * Several processes of the declaring program are live and the caller is none of them. The ids ride
 * the refusal so the caller can address one itself with the explicit `send({process, port}, …)`.
 */
export class AmbiguousProcess extends Schema.TaggedError<AmbiguousProcess>()(
	"tuval/authoring/AmbiguousProcess",
	{program: ProgramId, port: Schema.String, processes: Schema.Array(ProcessId)},
) {
	override get message(): string {
		return `program "${this.program}" has ${this.processes.length} live processes (${this.processes.join(", ")}) and the call came from none of them, so "${this.port}" names no one process`;
	}
}

export type OwnProcessRefused = NoLiveProcess | AmbiguousProcess;

/**
 * Resolve a bare port name to a process of `program`, by the three-case rule above. `port` is
 * carried only so a refusal can say which send was refused.
 */
export const resolveOwnProcess = Effect.fn("Tuval.Authoring.resolveOwnProcess")(function* (
	program: ProgramId,
	port: string,
	scope: Scope,
) {
	const table = yield* ProcessTable;
	const rows = yield* table.list;
	const mine = rows.filter((row) => row.programId === program).map((row) => row.id);
	const [only] = mine;
	if (only === undefined) return yield* new NoLiveProcess({program, port});
	if (mine.length === 1) return only;
	const caller = scope.process;
	if (caller !== undefined && mine.includes(caller)) return caller;
	return yield* new AmbiguousProcess({program, port, processes: mine});
});
