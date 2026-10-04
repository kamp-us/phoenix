/**
 * The folder a process runs in (#9694, ruling #9668 R3.1). A program runs in its project's folder,
 * and anything it starts runs there too unless the program names another folder for it.
 *
 * It is a service in the process's spawn set, not a field on the process. A spawned child's set
 * starts as a copy of its spawner's (`../commands/core/process.ts`), so a child inherits this with
 * no extra code. A spawner that means a different folder provides a different value for the one
 * spawn. The desk puts the home folder at the bottom, an open project puts its own folder over that
 * for its processes, and the picker names the folder of the project an entry was chosen for.
 *
 * Absent is legal: a kernel stood up from rows alone, as tests do, runs with no folder at all.
 */

import {Context, type Effect, type Option} from "effect";
import type {ProcessId} from "./process.ts";

export class WorkingFolder extends Context.Service<
	WorkingFolder,
	{
		/** An absolute path. */
		readonly path: string;
	}
>()("tuval/WorkingFolder") {}

/**
 * The folder a live process's spawn set carries, read by id. A spawner running inside a process
 * inherits that process's folder through its own context and needs none of this. A spell runs
 * under the kernel's context, whose folder is the home one, so the `process spawn` spell reads its
 * caller's folder here to start the child where the caller runs (#9694, #9898).
 *
 * `Processes.layer` builds this over the same map it spawns into, the way it builds `ProcessTable`.
 * None is a process that is not live, or one spawned with no folder in its set.
 */
export class ProcessFolders extends Context.Service<
	ProcessFolders,
	{
		readonly folderOf: (id: ProcessId) => Effect.Effect<Option.Option<WorkingFolder["Service"]>>;
	}
>()("tuval/ProcessFolders") {}
