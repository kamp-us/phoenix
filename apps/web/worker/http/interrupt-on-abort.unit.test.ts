/**
 * `interruptOnAbort` — the platform-edge abort wiring for the routes
 * assembled in `app.ts` (ADR 0043). alchemy's worker bridge runs the request
 * handler with `Effect.runPromiseExit` and wires no signal, so the HTTP edge
 * owns abort→interruption itself (effect-smol's `HttpEffect.toWebHandlerWith`
 * idiom: `request.signal` listener → fiber interrupt). T0: pure helper, no
 * router, no workerd.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {describe, expect, it} from "vitest";
import {type AbortSignalLike, interruptOnAbort} from "./interrupt-on-abort.ts";

describe("interruptOnAbort", () => {
	it("passes a completing program through untouched", async () => {
		const controller = new AbortController();
		const result = await Effect.runPromise(
			Effect.succeed(42).pipe(interruptOnAbort(controller.signal)),
		);
		expect(result).toBe(42);
		// A late abort (client gone after the response) must be a no-op.
		controller.abort();
	});

	it("propagates a typed failure unchanged", async () => {
		const controller = new AbortController();
		const exit = await Effect.runPromiseExit(
			Effect.fail("boom").pipe(interruptOnAbort(controller.signal)),
		);
		expect(exit).toEqual(Exit.fail("boom"));
	});

	it("an abort mid-flight interrupts the program", async () => {
		const controller = new AbortController();
		let started = false;
		const program = Effect.suspend(() => {
			started = true;
			return Effect.never;
		});
		const exitPromise = Effect.runPromiseExit(program.pipe(interruptOnAbort(controller.signal)));
		// Let the fiber start (fork + listener registration happen on fiber
		// start, not at construction).
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(started).toBe(true);
		controller.abort();
		const exit = await exitPromise;
		expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true);
	});

	it("an abort dispatched in the pre-check→listener gap still interrupts (recheck branch)", async () => {
		// `Effect.forkChild` is a fiber yield point between the `signal.aborted`
		// pre-check and `addEventListener` — an abort dispatched in that gap
		// fires no listener. A real AbortController can't hit the gap
		// deterministically, so simulate exactly what it looks like from the
		// helper's view: `aborted` reads false at the pre-check and true after,
		// and the registered listener never fires (the event already dispatched).
		let aborted = false;
		const gapSignal: AbortSignalLike = {
			get aborted() {
				const value = aborted;
				aborted = true; // flips after the first (pre-check) read
				return value;
			},
			// Registered too late: the event already dispatched, so the listener
			// is never invoked — only the recheck can interrupt.
			addEventListener: () => {},
			removeEventListener: () => {},
		};
		const exit = await Effect.runPromiseExit(Effect.never.pipe(interruptOnAbort(gapSignal)));
		expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true);
	});

	it("an already-aborted signal interrupts before the program starts", async () => {
		const controller = new AbortController();
		controller.abort();
		let started = false;
		const program = Effect.suspend(() => {
			started = true;
			return Effect.succeed("never seen");
		});
		const exit = await Effect.runPromiseExit(program.pipe(interruptOnAbort(controller.signal)));
		expect(started).toBe(false);
		expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true);
	});
});
