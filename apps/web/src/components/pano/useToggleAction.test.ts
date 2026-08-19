import {describe, expect, it} from "vitest";
import {
	nextToggleAction,
	runToggleLoop,
	type ToggleAction,
	type ToggleLoopState,
} from "./useToggleAction";

/**
 * A dispatch that settles only when the test says so, so the #818 / #825 race can be
 * interleaved deterministically — no timers, no DOM.
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

		h.setDesired(true);
		const loop = h.run();
		await tick();
		expect(h.calls).toEqual(["set"]);
		expect(h.hasPending()).toBe(true);

		// Click 2 lands INSIDE the in-flight window — the bug's exact timing.
		h.setDesired(false);

		h.settle();
		await tick();

		// Under the old `if (inFlight) return;` guard this unset never fired.
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

		// off then on → desired ends where the in-flight set already lands it, so no
		// corrective dispatch.
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
