/**
 * The booted kernel's `SpellBridge`, handed to a config module that is imported before the kernel
 * exists. Used by the local-only real-CLI harness (`./serve.ts`) and by nothing else.
 *
 * The `claude-session` row takes its kernel seam as a value — `claudeSession({kernel})` wants a
 * `Layer<SpellBridge>` at the moment the config module is evaluated (`../program.ts`) — and the
 * loader evaluates that module inside `boot`, before there is a bridge to hand it. So the harness
 * boots, takes the bridge out of the kernel context, and puts it here; the row's layer is built
 * later — when the founder opens the window, or when a restored row reconnects — and reads it then.
 *
 * **The hand-over happens inside `boot`, before `restore`.** `start` calls `handOverKernel` through
 * its `onKernel` hook (`../../boot.ts`), between the kernel's build and the first spawn, because
 * `restore` runs inside `boot` and its spawns build the rows' layers: a harness that filled this
 * holder after `boot` returned was too late for every checkpointed row, which is the restart the
 * harness exists to demonstrate ([#7976](https://github.com/kamp-us/phoenix/issues/7976)). The
 * hook's Scope is the booted app's, so a stop empties the holder rather than leaving a dead
 * kernel's bridge readable by the next boot.
 *
 * **This module is what makes that work, and only because the loader does not cache-bust it.**
 * `src/config.ts` stamps a load number on the *config module's* URL so each boot re-evaluates it;
 * an ordinary import inside that module resolves normally and keeps one instance across the two.
 * A holder written into the config module itself would be reset by every boot, which is exactly
 * what the restart run needs it not to be.
 *
 * It is scaffolding for a local harness and not a shape a user's config should have to know. That
 * the `kernel` arm has no config-reachable value at all is
 * [#7958](https://github.com/kamp-us/phoenix/issues/7958).
 */

import {Context, Effect, Layer, type Scope} from "effect";
import type {Kernel} from "../../boot.ts";
import {SpellBridge} from "../../commands/bridge/index.ts";

let held: Context.Context<SpellBridge> | null = null;

/** `boot`'s `onKernel` hook: fill the holder, and empty it again when the booted app stops. */
export const handOverKernel = (
	kernel: Context.Context<Kernel>,
): Effect.Effect<void, never, Scope.Scope> =>
	Effect.gen(function* () {
		held = Context.make(SpellBridge, Context.get(kernel, SpellBridge));
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				held = null;
			}),
		);
	});

/**
 * The bridge as a layer the row can hold before it exists. It dies rather than answering an empty
 * bridge: a `spawn` that silently reached nothing would read as the model declining to delegate.
 */
export const lateSpellBridge: Layer.Layer<SpellBridge> = Layer.unwrap(
	Effect.suspend(() =>
		held === null
			? Effect.die(
					new Error(
						"the Claude real-CLI harness opened a session before handing the kernel over; see src/claude/proof/late.ts",
					),
				)
			: Effect.succeed(Layer.succeedContext(held)),
	),
);
