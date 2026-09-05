/**
 * The three kernel tools as the model reaches them, bound to one live Claude process.
 *
 * `../tools/server.ts` turns a `KernelBridge` into the MCP server the SDK mounts, and
 * `KernelBridge.live` turns the kernel's program-blind `SpellBridge` into that bridge. This module
 * is the one seam between them a proof has to build for itself: **which process a call is a child
 * of**. The kernel never trusts an id on the wire — `SpellBridge.call` puts only the caller's
 * window on it and the executor re-resolves the process through `WindowIndex` (#7617 R2.2) — so a
 * spawn is parented by the index and by nothing else.
 *
 * `boot` builds that index empty, because the shell does not own one yet: the comment at
 * `src/boot.ts`'s `WindowIndex.scripted({})` says so, and `src/commands/scope.ts` names the shell
 * (#7499) as the implementer. So this module stands one up over the kernel's own registry — the
 * real `SpellExecutor` over the real `Registry`, `Processes` and `SpawnedProcesses` — with the one
 * entry the desk actually holds: the window the picker bound to the Claude process. Everything a
 * call then touches is the booted kernel's; the only thing supplied here is the answer to "whose
 * child is this", which the shell will supply once it adopts the registry
 * ([#7894](https://github.com/kamp-us/phoenix/issues/7894)).
 *
 * Two things below look like ceremony and are not. The contexts are merged one step at a time
 * rather than composed with `Layer.provide`, because the booted kernel already carries a
 * `WindowIndex`, a `SpellExecutor` and a `SpellBridge` of its own and the whole question here is
 * which of each pair wins: `Context.merge(self, that)` is documented to let `that` override, so
 * each step names its winner. And `SpellExecutor.layer` is wrapped in `Layer.fresh`, because it is
 * one module-level `Layer` value that `boot` has already built — without the wrapper the build
 * hands back boot's memoized executor, the one holding the empty index, and every `spawn` here
 * answers `NoSuchWindow` while looking correctly wired.
 */

import {Context, Effect, Layer} from "effect";
import type {Kernel} from "../../boot.ts";
import {everyRegistered, SpellBridge} from "../../commands/bridge/index.ts";
import {NoSuchWindow} from "../../commands/errors.ts";
import {SpellExecutor} from "../../commands/executor.ts";
import {WindowIndex} from "../../commands/scope.ts";
import {ClientId, type Scope as SpellScope, WindowId, WorkspaceId} from "../../commands/spell.ts";
import type {ProcessId} from "../../process/process.ts";
import {
	KernelBridge,
	type ToolRuntime,
	type TuvalToolServer,
	tuvalToolServer,
} from "../tools/index.ts";

export interface ClaudeToolsOptions {
	/** The booted kernel: where the registry, the process table and the spawner all live. */
	readonly kernel: Context.Context<Kernel>;
	/** The window the picker bound to the Claude process — the caller's own, on the wire. */
	readonly window: string;
	/** The process that window shows: the parent every `spawn` through these tools gets. */
	readonly process: ProcessId;
	readonly workspace: string;
	readonly client: string;
}

/**
 * The tool server one Claude process would mount, over the live kernel.
 *
 * The runtime a handler runs its Effect through carries the kernel's context, because a spell's own
 * requirements are erased by the registry and the composition root owes them at the call
 * (`../../commands/executor.ts`). Handing it the booted context is that root, here.
 */
export const claudeTools = Effect.fn("Tuval.ClaudeVerticalProof.claudeTools")(function* (
	options: ClaudeToolsOptions,
) {
	const window = WindowId.make(options.window);
	const workspace = WorkspaceId.make(options.workspace);
	const scope: SpellScope = {window, workspace, client: ClientId.make(options.client)};

	const index = WindowIndex.of({
		resolve: (asked) =>
			asked === window
				? Effect.succeed({process: options.process, workspace})
				: Effect.fail(new NoSuchWindow({window: asked})),
	});

	const withIndex = Context.add(options.kernel, WindowIndex, index);
	const executor = yield* Layer.build(Layer.fresh(SpellExecutor.layer)).pipe(
		Effect.provideContext(withIndex),
	);
	const withExecutor = Context.merge(withIndex, executor);
	const bridge = yield* Layer.build(Layer.fresh(SpellBridge.layer({allow: everyRegistered}))).pipe(
		Effect.provideContext(withExecutor),
	);
	const kernelBridge = yield* Layer.build(KernelBridge.live(scope)).pipe(
		Effect.provideContext(Context.merge(withExecutor, bridge)),
	);

	// `ClaudeAiAgent`'s own shape (`../agent/ClaudeAiAgent.ts`): the SDK gives no hook for handing it
	// an Effect runtime, so a handler is a plain `async` function and Effect runs inside it over the
	// services the caller was built with — here, the booted kernel plus this module's index.
	const runtime: ToolRuntime = {runPromise: Effect.runPromiseWith(withIndex)};

	const server: TuvalToolServer = tuvalToolServer(Context.get(kernelBridge, KernelBridge), runtime);
	return server;
});
