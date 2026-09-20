/**
 * Handing a running process an event on behalf of another process, and the envelope an `ask` rides
 * in.
 *
 * The kernel could route a payload *to* a port and it could latch a payload *off* one, and neither
 * of those is an answer: a port is one-way and carries no return address, so an `ask`'s reply and a
 * child out-port routed back into its spawner's events both had nowhere to land (#8756). What was
 * missing is one primitive — put an event in a named process's inbox, addressed from outside — and
 * `deliver` is it.
 *
 * It lives beside `Processes` rather than on `SpawnedProcesses` because the process being answered
 * is any live process, not only one the process spells spawned: the picker opens a program straight
 * through `Processes` (`../shell/picker/open.ts`), so an answer routed through the spells' own
 * table would never reach a picker-opened caller. The live handle is the whole of what a delivery
 * needs, and `Processes.handle` is where handles are.
 *
 * A delivery is best-effort by design, exactly as the shell's key forwarding is: a process that has
 * stopped has no inbox to be handed anything, and a fold that fails on the event it was handed is
 * the receiver's own failure, reported where it happened rather than raised at whoever answered.
 */

import {type Context, Effect, Option} from "effect";
import type {Processes} from "./Processes.ts";
import type {Message, ProcessId} from "./process.ts";

/**
 * Where one `ask` wants its answer. Opaque on purpose: the caller's process and the event the reply
 * arrives as are the kernel's own copy, held against the correlation it minted, so a callee holding
 * this value can answer the question it was asked and address nothing else — no authoring effect
 * takes a process id as input to set a relation (founder's ruling on #8757).
 */
export interface ReplyTo {
	readonly correlation: string;
}

const ASKED = Symbol.for("tuval/process/Asked");

/**
 * What an `ask` puts on the callee's in-port queue: the payload that port's own `accepts` already
 * admitted, plus where the answer goes. The symbol key is what makes it unmistakable for a payload
 * — the queue is untyped and this envelope never crosses a wire, so a tag no author can spell is
 * cheaper and safer than a shape a payload could accidentally match.
 */
export interface Asked {
	readonly [ASKED]: true;
	readonly payload: unknown;
	readonly reply: ReplyTo;
}

export const asked = (payload: unknown, reply: ReplyTo): Asked => ({
	[ASKED]: true,
	payload,
	reply,
});

export const isAsked = (value: unknown): value is Asked =>
	typeof value === "object" && value !== null && (value as Partial<Asked>)[ASKED] === true;

/** The address a request-port arrival carries when nobody asked — a plain `send` reached it. */
export const NO_REPLY: ReplyTo = {correlation: ""};

/**
 * Put one event in `to`'s inbox. Answers `true` when a live process took it and `false` when there
 * was none to take it; a fold that fails on the event is logged and still counts as taken, because
 * the event did land and the failure is the receiver's.
 */
export const deliver = (
	processes: Context.Service.Shape<typeof Processes>,
	to: ProcessId,
	event: Message,
): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const handle = yield* processes.handle(to);
		if (Option.isNone(handle)) {
			yield* Effect.logDebug(`deliver: process ${to} is gone; "${event.type}" was dropped`);
			return false;
		}
		yield* handle.value.dispatch(event).pipe(Effect.catchCause((cause) => Effect.logError(cause)));
		return true;
	});
