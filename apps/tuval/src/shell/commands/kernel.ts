/**
 * The kernel's `ShellDispatch`: the Msg goes to the live process of the desk's program row.
 *
 * Kept apart from `./dispatch.ts` because that module is on the page's import path and this one
 * reaches the process table, which reads `node:crypto` at load; the page's boundary test
 * (`src/page/boundary.unit.test.ts`) is what keeps them apart (#7910). Only `src/boot.ts` imports
 * this.
 */

import {Effect, Layer, Option} from "effect";
import {Processes} from "../../process/Processes.ts";
import {ProcessTable} from "../../process/ProcessTable.ts";
import type {ProgramId} from "../../registry/program.ts";
import {NoDesk, ShellDispatch} from "./dispatch.ts";

/**
 * The row is resolved per dispatch rather than at layer build, because the kernel is built before
 * any process exists and a desk can be stopped and spawned again under the same program id.
 * `program` is a parameter because `shellId` lives in `../program.ts`, which the page also reaches — boot names it, and a boot whose config registered no shell row answers `NoDesk`.
 */
export const shellDispatchKernel = (
	program: ProgramId,
): Layer.Layer<ShellDispatch, never, Processes | ProcessTable> =>
	Layer.effect(
		ShellDispatch,
		Effect.gen(function* () {
			const processes = yield* Processes;
			const table = yield* ProcessTable;
			return ShellDispatch.of({
				dispatch: (msg) =>
					Effect.gen(function* () {
						const rows = yield* table.list;
						const row = rows.find((candidate) => candidate.programId === program);
						const handle = row === undefined ? Option.none() : yield* processes.handle(row.id);
						if (Option.isNone(handle)) return yield* new NoDesk({program});
						yield* handle.value.dispatch(msg);
					}),
			});
		}),
	);
