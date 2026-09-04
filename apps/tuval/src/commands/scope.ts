/**
 * Where a call came from, decided by the kernel (#7617 R2.2).
 *
 * The wire lets a page name the window it called from and nothing else: the process and the
 * workspace are looked up here, so a page cannot address another process by putting an id on the
 * wire. A spell that legitimately targets another process takes that id as an argument of its own
 * `params` and is answerable for it.
 *
 * The kernel has no window noun (#7632 R1.2), so `WindowIndex` is an interface this slice declares
 * and the shell (#7499) implements when it adopts the registry. Until then `WindowIndex.scripted`
 * answers from a fixture — the founder's 2026-09-03 ruling on #7638.
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
