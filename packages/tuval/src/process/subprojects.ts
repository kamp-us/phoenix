/**
 * Subprojects, as a program reaches them (#9689, ruling #9668 R4.3 and R5.1). A subproject is a
 * project nested under another: a folder with its own config, state and programs, which inherits
 * its parent's trust and grouping and closes with it. A program opens one under the project it runs
 * in, and becomes its opener: the one program that crosses the boundary between the two.
 *
 * `Subprojects` is a service in the process's spawn set, the way `WorkingFolder` is: the desk puts
 * one in each open project's set, so a process knows which project it would open under without
 * naming it, and a process the desk's own graph runs has none. Absent is legal, and `openSubproject`
 * refuses there rather than guessing a parent.
 *
 * An open or a close is a request. It is answered once the desk has taken it, and the project opens
 * or closes after that, because a program asking from its own restore runs inside its project's
 * open, which the desk has not finished yet. A request that fails later is logged by the desk,
 * naming the folder.
 *
 * `ProcessBoundary` is the other half: what the kernel asks before a process sends to, asks or
 * spawns into another process, so a subproject's programs cannot reach up to its parent and the
 * parent's programs other than the opener cannot reach down. The desk owns the rule; a kernel with
 * no desk has no boundary and refuses nothing.
 */

import {Context, Effect, Option, Schema} from "effect";
import type {ProgramId} from "../registry/program.ts";
import type {ProcessId} from "./process.ts";
import {ProcessSelf} from "./self.ts";

/** A subproject open or close the desk would not take, and why. */
export class SubprojectRefused extends Schema.TaggedError<SubprojectRefused>()(
	"tuval/SubprojectRefused",
	{folder: Schema.String, reason: Schema.String},
) {
	override get message(): string {
		return `could not open or close the subproject ${this.folder}: ${this.reason}`;
	}
}

/** A process reaching across a subproject boundary it may not cross. Both ends are named. */
export class CrossingRefused extends Schema.TaggedError<CrossingRefused>()(
	"tuval/CrossingRefused",
	{from: Schema.String, to: Schema.String, reason: Schema.String},
) {
	override get message(): string {
		return `${this.from} cannot reach ${this.to}: ${this.reason}`;
	}
}

export class Subprojects extends Context.Service<
	Subprojects,
	{
		/** Ask to open `folder`, an absolute path, as a subproject opened by `opener`. */
		readonly open: (opener: ProcessId, folder: string) => Effect.Effect<void, SubprojectRefused>;
		/** Ask to close the subproject at `folder`. Only its opener may. */
		readonly close: (opener: ProcessId, folder: string) => Effect.Effect<void, SubprojectRefused>;
	}
>()("tuval/Subprojects") {}

export class ProcessBoundary extends Context.Service<
	ProcessBoundary,
	{
		/** Refuses when `from` may not send to or ask `to`. */
		readonly reach: (from: ProcessId, to: ProcessId) => Effect.Effect<void, CrossingRefused>;
		/** Refuses when `from` may not spawn a process of `program`. */
		readonly spawn: (from: ProcessId, program: ProgramId) => Effect.Effect<void, CrossingRefused>;
	}
>()("tuval/ProcessBoundary") {}

/** The process a handler runs as, and the service it would ask; either may be absent. */
const asking = (folder: string) =>
	Effect.gen(function* () {
		const self = yield* Effect.serviceOption(ProcessSelf);
		const subprojects = yield* Effect.serviceOption(Subprojects);
		if (Option.isNone(self) || Option.isNone(subprojects)) {
			return yield* new SubprojectRefused({
				folder,
				reason: "this process runs in no project, so there is no project to open it under",
			});
		}
		return {opener: self.value.id, subprojects: subprojects.value};
	});

/**
 * Open `folder` as a subproject of the project this handler's process runs in, with this process
 * as its opener. On a desk restart nothing reopens a subproject but its opener calling this again.
 */
export const openSubproject = (folder: string): Effect.Effect<void, SubprojectRefused> =>
	Effect.flatMap(asking(folder), ({opener, subprojects}) => subprojects.open(opener, folder));

/** Close the subproject at `folder`, which this handler's process opened. */
export const closeSubproject = (folder: string): Effect.Effect<void, SubprojectRefused> =>
	Effect.flatMap(asking(folder), ({opener, subprojects}) => subprojects.close(opener, folder));

/** The boundary's answer for the handler's process reaching `to`; nothing to ask is a yes. */
export const guardReach = (to: ProcessId): Effect.Effect<void, CrossingRefused> =>
	Effect.gen(function* () {
		const self = yield* Effect.serviceOption(ProcessSelf);
		const boundary = yield* Effect.serviceOption(ProcessBoundary);
		if (Option.isSome(self) && Option.isSome(boundary)) {
			yield* boundary.value.reach(self.value.id, to);
		}
	});

/** The boundary's answer for the handler's process spawning `program`; nothing to ask is a yes. */
export const guardSpawn = (program: ProgramId): Effect.Effect<void, CrossingRefused> =>
	Effect.gen(function* () {
		const self = yield* Effect.serviceOption(ProcessSelf);
		const boundary = yield* Effect.serviceOption(ProcessBoundary);
		if (Option.isSome(self) && Option.isSome(boundary)) {
			yield* boundary.value.spawn(self.value.id, program);
		}
	});
