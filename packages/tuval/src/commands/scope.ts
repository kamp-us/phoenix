/**
 * Where a call came from, decided by the kernel (#7617 R2.2).
 *
 * The wire lets a page name the window it called from and nothing else: the process and the
 * workspace are looked up here, so a page cannot address another process by putting an id on the
 * wire. A spell that legitimately targets another process takes that id as an argument of its own
 * `params` and is answerable for it.
 *
 * The kernel has no window noun (#7632 R1.2), so `WindowIndex` is an interface this slice declares
 * and the shell implements: `shellWindowIndexKernel` (`../shell/commands/kernel.ts`) reads the live
 * desk, and boot provides it (#7894). `WindowIndex.scripted` answers from a fixture, for a test
 * that wants a fixed table rather than a running desk.
 */

import {Context, Effect, Layer} from "effect";
import type {ProcessId} from "../process/process.ts";
import {NoSuchWindow} from "./errors.ts";
import type {ClientId, Scope, WindowId, WorkspaceId} from "./spell.ts";

/** Where one window is: the process it shows, when it shows one, and the workspace holding it. */
export interface WindowPlacement {
	readonly process?: ProcessId;
	readonly workspace: WorkspaceId;
}

/** The caller as the kernel knows it: who it is, and which workspace it is looking at. */
export interface Client {
	readonly id: ClientId;
	readonly workspace: WorkspaceId;
}

export class WindowIndex extends Context.Service<
	WindowIndex,
	{
		readonly resolve: (window: WindowId) => Effect.Effect<WindowPlacement, NoSuchWindow>;
	}
>()("tuval/WindowIndex") {
	/** The index over a fixed table — the deterministic layer tests and the shell-less kernel use. */
	static readonly scripted = (
		table: Readonly<Record<string, WindowPlacement>>,
	): Layer.Layer<WindowIndex> =>
		Layer.succeed(
			WindowIndex,
			WindowIndex.of({
				resolve: (window) => {
					const placement = table[window];
					return placement === undefined
						? Effect.fail(new NoSuchWindow({window}))
						: Effect.succeed(placement);
				},
			}),
		);
}

/**
 * The scope for one call. With a window, every field comes from the index; without one, the call is
 * workspace-wide and names no process.
 */
export const resolveScope = Effect.fn("Tuval.Commands.resolveScope")(function* (
	call: {readonly window?: WindowId},
	client: Client,
) {
	if (call.window === undefined) {
		return {workspace: client.workspace, client: client.id} satisfies Scope;
	}
	const index = yield* WindowIndex;
	const placement = yield* index.resolve(call.window);
	return {
		window: call.window,
		...(placement.process === undefined ? {} : {process: placement.process}),
		workspace: placement.workspace,
		client: client.id,
	} satisfies Scope;
});

/**
 * The window a process was opened into, as the spawner named it (#8758).
 *
 * `WindowIndex` answers "which process does this window show"; this is the other direction, and it
 * exists because a process cannot read it. The window is the only thing a caller may put on the
 * wire — the executor re-resolves the process from it (#7617 R2.2) — so a caller with no window has
 * no way to be anyone's child, which is what made every agent-tool `spawn` a root.
 *
 * It is a service a spawner adds to the context it hands a child rather than a field of the row,
 * for the reason a config module cannot state one: a row is built inside `boot`, before any window
 * exists. `../shell/picker/open.ts` is the one place that adds it, because opening a program into a
 * window is the one spawn that knows which window. A process started any other way — the graph's
 * launcher, `durability/restore.ts` — carries none and is read with `Effect.serviceOption`, so
 * absence is the ordinary case and not a missing dependency.
 *
 * The id is the window as it stood at the open. Re-binding that window to another process moves
 * what it resolves to, which is a staleness only a process-scoped `self` can close (#8757).
 */
export class CallingWindow extends Context.Service<CallingWindow, {readonly window: WindowId}>()(
	"tuval/CallingWindow",
) {}
