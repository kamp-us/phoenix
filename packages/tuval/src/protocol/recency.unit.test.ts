import {assert, describe, it} from "@effect/vitest";
import * as fixtures from "./fixtures.ts";
import {WindowId} from "./ids.ts";
import {Snapshot} from "./messages.ts";
import {focusWindow, nextRecency} from "./recency.ts";

const {snapshot, leftWindow, rightWindow} = fixtures;

describe("nextRecency", () => {
	it("is one past the highest stamp on the desk, windows and processes together", () => {
		// The fixture's highest stamp is the left window's 3.
		assert.strictEqual(nextRecency(snapshot), 4);
	});

	it("counts a process row's stamp too, so a spawn cannot reuse a focus's number", () => {
		const withOlderWindows = new Snapshot({
			...snapshot,
			windows: {
				[leftWindow]: {id: leftWindow, recency: 1},
				[rightWindow]: {id: rightWindow, recency: 1},
			},
		});
		assert.strictEqual(nextRecency(withOlderWindows), 3);
	});

	it("starts at 1 on a desk that carries no stamps at all", () => {
		assert.strictEqual(nextRecency(new Snapshot({...snapshot, windows: {}, processes: []})), 1);
	});
});

describe("focusWindow", () => {
	it("stamps the focused window as the most recent one, leaving every other row alone", () => {
		const after = focusWindow(snapshot, rightWindow);
		assert.strictEqual(after.windows[rightWindow]?.recency, 4);
		assert.strictEqual(after.windows[leftWindow]?.recency, snapshot.windows[leftWindow]?.recency);
		assert.strictEqual(
			snapshot.windows[rightWindow]?.recency,
			1,
			"focusing rewrote the snapshot it was given",
		);
	});

	it("orders two focus changes by the order they happened", () => {
		const once = focusWindow(snapshot, rightWindow);
		const twice = focusWindow(once, leftWindow);
		assert.isAbove(
			twice.windows[leftWindow]?.recency ?? 0,
			twice.windows[rightWindow]?.recency ?? 0,
		);
	});

	it("changes nothing for a window the desk does not hold", () => {
		assert.strictEqual(focusWindow(snapshot, WindowId.make("w-gone")), snapshot);
	});
});
