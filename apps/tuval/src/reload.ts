/**
 * The delivery half of a config reload: hand every live process the Msgs its own row says a
 * re-read config means for it (`registry/program.ts`'s `configChanged`, #7509 ruling 3).
 *
 * It sits beside `boot.ts` rather than in either slice because it is the one place the two
 * generations of program rows meet: `Booted.reload` holds the config it just read, and the
 * processes it walks were spawned from the one before it. The `Registry` is not that pair — it
 * still holds the boot generation after any number of reloads, which is exactly why the running
 * generation is carried through `boot`'s own closure instead.
 *
 * A dispatch that fails is logged and the walk goes on: a reload is a read of the config, and one
 * process refusing a Msg must not turn it into a refusal of the whole re-read.
 */

import {Effect, Option} from "effect";
import {Processes} from "./process/Processes.ts";
import {ProcessTable} from "./process/ProcessTable.ts";
import type {Message} from "./process/process.ts";
import type {AnyProgram, ProgramId} from "./registry/program.ts";

const byId = (rows: ReadonlyArray<AnyProgram>): ReadonlyMap<ProgramId, AnyProgram> =>
	new Map(rows.map((row) => [row.id, row]));

/**
 * Answers how many live processes were handed a change, which is what `ReloadReport` carries: a
 * reload that moved no row a process is running under answers zero.
 */
export const dispatchConfigChanged = (
	previous: ReadonlyArray<AnyProgram>,
	next: ReadonlyArray<AnyProgram>,
): Effect.Effect<number, never, ProcessTable | Processes> =>
	Effect.gen(function* () {
		const table = yield* ProcessTable;
		const processes = yield* Processes;
		const running = byId(previous);
		const reloaded = byId(next);
		let notified = 0;
		for (const row of yield* table.list) {
			const spawnedFrom = running.get(row.programId);
			const replacement = reloaded.get(row.programId);
			if (spawnedFrom?.configChanged === undefined || replacement === undefined) continue;
			const messages = spawnedFrom.configChanged(replacement) as ReadonlyArray<Message>;
			if (messages.length === 0) continue;
			const handle = yield* processes.handle(row.id);
			if (Option.isNone(handle)) continue;
			// Serial: a row's answer is an ordered list, and dispatching it in parallel would apply
			// two of one process's Msgs in whichever order the fibers happened to win.
			yield* Effect.forEach(messages, handle.value.dispatch, {
				concurrency: 1,
				discard: true,
			}).pipe(Effect.catch((error) => Effect.logError(error)));
			notified += 1;
		}
		return notified;
	}).pipe(Effect.withSpan("Tuval.reload.dispatchConfigChanged"));
