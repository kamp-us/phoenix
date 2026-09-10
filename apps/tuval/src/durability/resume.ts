/**
 * The last step of a restore: hand a process the kernel just brought back the Msgs its own row
 * says a spawner sends it (`registry/program.ts`'s `resume`).
 *
 * It lives here rather than in either spawner because both take it — `src/launch/` for a graph
 * node whose checkpoint existed, `./restore.ts` for a checkpointed process the graph does not
 * plan — and a second copy would be a second thing to keep in step. The kernel reads what the
 * Msgs mean nowhere: a row that declares no `resume` has nothing to resume, and a state with
 * nothing to resume answers with an empty list (#7877).
 */

import {Effect} from "effect";
import type {DispatchError} from "../host/actor.ts";
import type {HandlerFailed} from "../process/errors.ts";
import type {ProcessHandle} from "../process/process.ts";
import type {AnyProgram} from "../registry/program.ts";

export const dispatchResume = (
	row: AnyProgram | undefined,
	handle: ProcessHandle,
): Effect.Effect<void, DispatchError<HandlerFailed>> =>
	Effect.forEach(row?.resume?.(handle.getState()) ?? [], handle.dispatch, {discard: true});
