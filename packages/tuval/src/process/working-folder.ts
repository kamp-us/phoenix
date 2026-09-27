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

import {Context} from "effect";

export class WorkingFolder extends Context.Service<
	WorkingFolder,
	{
		/** An absolute path. */
		readonly path: string;
	}
>()("tuval/WorkingFolder") {}
