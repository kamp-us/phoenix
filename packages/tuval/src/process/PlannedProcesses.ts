import {Context, type Effect} from "effect";
import type {ProcessId} from "./process.ts";

/**
 * Which process ids the config's graph declared — the one runtime-readable answer to "would boot
 * start this again?", and the reason `Processes.remove` can refuse a graph-declared process
 * (#9446). Nothing could answer it before: `compile(graph)` is a local in `src/boot.ts`, `launch`
 * returns `LaunchedProcess` values no service retains, and a `ProcessRow` carries no origin field.
 *
 * Write-once-per-launch and read-only after: `src/launch/launch.ts` declares the compiled graph's
 * node ids as it spawns them, and `Processes.layer` builds this over the same set `remove` reads,
 * the way it already builds `ProcessTable` over the map it spawns into.
 *
 * The set is the compiled graph's, never "was this id in the manifest": a restored process and a
 * planned one both come back at their saved id, so the manifest cannot tell them apart.
 */
export class PlannedProcesses extends Context.Service<
	PlannedProcesses,
	{
		/** Record ids the compiled graph plans. Additive — a second launch adds, never replaces. */
		readonly declare: (ids: Iterable<ProcessId>) => Effect.Effect<void>;
		readonly isPlanned: (id: ProcessId) => Effect.Effect<boolean>;
	}
>()("tuval/PlannedProcesses") {}
