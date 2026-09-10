/**
 * The two kernel-side services the desk backs: `ShellDispatch`, whose Msg goes to the live process
 * of the desk's program row, and `WindowIndex`, which reads that same process's state to say where
 * a window is.
 *
 * Kept apart from `./dispatch.ts` because that module is on the page's import path and this one
 * reaches the process table, which reads `node:crypto` at load; the page's boundary test
 * (`src/page/boundary.unit.test.ts`) is what keeps them apart (#7910). `src/commands/scope.ts` is
 * on that path too, which is why the index's implementation is here and not beside its tag. Only
 * `src/boot.ts` imports this.
 */

import {Effect, Layer, Option} from "effect";
import {NoSuchWindow} from "../../commands/errors.ts";
import {WindowIndex, type WindowPlacement} from "../../commands/scope.ts";
import {type WindowId, WorkspaceId} from "../../commands/spell.ts";
import {Processes} from "../../process/Processes.ts";
import {ProcessTable} from "../../process/ProcessTable.ts";
import {ProcessId} from "../../process/process.ts";
import type {ProgramId} from "../../registry/program.ts";
import {hasWindow, processOf, type ShellState} from "../core/index.ts";
import {shellStateOf} from "../program.ts";
import {NoDesk, ShellDispatch} from "./dispatch.ts";

/**
 * The row is resolved per dispatch rather than at layer build, because the kernel is built before
 * any process exists and a desk can be stopped and spawned again under the same program id.
 * `program` is a parameter so this module stays a layer over the process table and nothing else:
 * boot names the shell row's id, and a boot whose config registered no shell row answers `NoDesk`.
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

/**
 * The window as the desk holds it, or `undefined` when no workspace holds it at all. The layout
 * tree's ids are plain strings and the kernel's are branded (#7700), so the brands' own
 * constructors do the one conversion — there is no `as` anywhere on this path.
 */
const placementOf = (state: ShellState, window: WindowId): WindowPlacement | undefined => {
	for (const workspaceId of state.order) {
		const workspace = state.workspaces[workspaceId];
		if (workspace === undefined || !hasWindow(workspace, window)) continue;
		const process = processOf(workspace, window);
		return {
			workspace: WorkspaceId.make(workspace.id),
			...(process === null ? {} : {process: ProcessId.make(process)}),
		};
	}
	return undefined;
};

/**
 * The kernel's `WindowIndex`, read off the desk's own live state — the same row `shellDispatchKernel`
 * dispatches into, resolved per call for the same reason (#7894).
 *
 * A window bound to a process the table no longer holds resolves to its workspace and no process
 * rather than failing: the desk keeps such a window as a placeholder (`windowBindings`), so the
 * scope a spell sees has to say the same thing. A boot whose config registered no shell row has no
 * state to read, which is `NoSuchWindow` for every window — the index's shape of `NoDesk`.
 */
export const shellWindowIndexKernel = (
	program: ProgramId,
): Layer.Layer<WindowIndex, never, Processes | ProcessTable> =>
	Layer.effect(
		WindowIndex,
		Effect.gen(function* () {
			const processes = yield* Processes;
			const table = yield* ProcessTable;
			return WindowIndex.of({
				resolve: (window) =>
					Effect.gen(function* () {
						const rows = yield* table.list;
						const desk = rows.find((candidate) => candidate.programId === program);
						const state = desk === undefined ? null : shellStateOf(desk.stateSummary().state);
						const placement = state === null ? undefined : placementOf(state, window);
						if (placement === undefined) return yield* new NoSuchWindow({window});
						if (placement.process === undefined) return placement;
						const handle = yield* processes.handle(placement.process);
						return Option.isNone(handle) ? {workspace: placement.workspace} : placement;
					}),
			});
		}),
	);
