import {describe, expect, it} from "vitest";
import {
	nextToggleAction,
	runToggleLoop,
	type ToggleAction,
	type ToggleLoopState,
} from "./useToggleAction";

/**
 * A controllable harness modelling the hook's refs + a fate dispatch that
 * settles only when we tell it to — so a test can interleave a "supersede"
 * toggle while a dispatch is still in flight, reproducing the #818 / #825 race
 * deterministically (no timers, no DOM).
 */
function harness(initialOn: boolean) {
	let on = initialOn;
	let desired: boolean | null = null;
	const calls: ToggleAction[] = [];
	let pending: (() => void) | null = null;

	const state = (): ToggleLoopState => ({
		desired,
		clearDesired: () => {
			desired = null;
		},
		read: () => ({
			on,
			dispatch: (action) =>
				new Promise<void>((resolve) => {
					calls.push(action);
					pending = () => {
						// The optimistic write + server reconcile lands the on-state.
						on = action === "set";
						pending = null;
						resolve();
					};
				}),
		}),
	});

	return {
		calls,
		setDesired: (v: boolean) => {
			desired = v;
		},
		/** Settle the currently in-flight dispatch. */
		settle: () => {
			if (!pending) throw new Error("no dispatch in flight to settle");
			pending();
		},
		hasPending: () => pending != null,
		run: () => runToggleLoop(state),
	};
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("nextToggleAction", () => {
	it("is null when achieved already matches desired (no same-action double-fire)", () => {
		expect(nextToggleAction(false, false)).toBeNull();
		expect(nextToggleAction(true, true)).toBeNull();
	});
	it("sets to reach desired-true, unsets to reach desired-false", () => {
		expect(nextToggleAction(false, true)).toBe("set");
		expect(nextToggleAction(true, false)).toBe("unset");
	});
});

describe("runToggleLoop — the #818 / #825 race", () => {
	it("does NOT drop an unset issued while the set mutation is still in flight", async () => {
		const h = harness(false);

		// Click 1: set. Starts the loop; first dispatch is now in flight.
		h.setDesired(true);
		const loop = h.run();
		await tick();
		expect(h.calls).toEqual(["set"]);
		expect(h.hasPending()).toBe(true);

		// Click 2 lands INSIDE the in-flight window (the bug's exact timing) —
		// supersede the desired end-state back to "off".
		h.setDesired(false);

		// The set POST resolves only now (its ~370ms round-trip).
		h.settle();
		await tick();

		// The unset MUST fire — under the old `if (inFlight) return;` it never did.
		expect(h.calls).toEqual(["set", "unset"]);
		expect(h.hasPending()).toBe(true);
		h.settle();
		await loop;
		expect(h.calls).toEqual(["set", "unset"]);
	});

	it("collapses on→off→on (back to the start) to a single in-flight set", async () => {
		const h = harness(false);

		h.setDesired(true); // click 1
		const loop = h.run();
		await tick();
		expect(h.calls).toEqual(["set"]);

		// Two more clicks while in flight: off then on → desired ends at true,
		// which the in-flight set already achieves, so no corrective dispatch.
		h.setDesired(false);
		h.setDesired(true);

		h.settle();
		await loop;
		expect(h.calls).toEqual(["set"]);
	});

	it("serializes — only one dispatch is in flight at any time", async () => {
		const h = harness(false);
		h.setDesired(true);
		const loop = h.run();
		await tick();
		// A second click while the first is pending must NOT start a parallel POST.
		h.setDesired(false);
		await tick();
		expect(h.calls).toEqual(["set"]); // still just the first, second is queued
		h.settle();
		await tick();
		expect(h.calls).toEqual(["set", "unset"]);
		h.settle();
		await loop;
	});
});
