/**
 * The picker carries nothing across a mount: mount it, change the registry, mount it again, and the
 * second mount shows the second registry — there is no cache to invalidate because there is nothing
 * to cache.
 */

import {assert, describe, expect, it} from "@effect/vitest";
import {Effect} from "effect";
import {readEntries} from "./entries.ts";
import {pickerHarness, programRow, windowId} from "./fixtures.ts";
import {pickerFrame} from "./frame.ts";
import {mountPicker} from "./view.ts";

const window = windowId("window-1");

describe("a mount reads the world fresh", () => {
	it.effect("a second mount after a registry change lists the new rows and none of the old", () =>
		Effect.gen(function* () {
			const listed = yield* Effect.scoped(
				Effect.gen(function* () {
					const before = yield* pickerHarness([programRow("counter", {label: "Counter"})]);
					const first = yield* readEntries.pipe(Effect.provide(before.layer));

					const after = yield* pickerHarness([
						programRow("pi", {label: "Pi"}),
						programRow("claude", {label: "Claude"}),
					]);
					const second = yield* readEntries.pipe(Effect.provide(after.layer));
					return [first, second] as const;
				}),
			);
			const [first, second] = listed;
			assert.deepStrictEqual(
				first.programs.map((entry) => entry.label),
				["Counter"],
			);
			assert.deepStrictEqual(
				second.programs.map((entry) => entry.label),
				["Pi", "Claude"],
			);

			// The frame is the mount's whole output, so the stale row cannot survive anywhere else.
			const frame = pickerFrame(window, second, mountPicker());
			assert.deepStrictEqual(
				frame.groups[0]?.options.map((option) => option.detail),
				["pi", "claude"],
			);
			assert.strictEqual(frame.activeDescendant, "picker-window-1-option-0");
		}),
	);

	it("a fresh mount starts unplaced with no refusal, whatever the last one ended on", () => {
		expect(mountPicker()).toEqual({
			cursor: null,
			refusal: null,
			previous: null,
			filter: null,
			step: null,
			landing: null,
		});
		expect(mountPicker("p-1")).toEqual({
			cursor: null,
			refusal: null,
			previous: "p-1",
			filter: null,
			step: null,
			landing: null,
		});
		expect(mountPicker()).not.toBe(mountPicker());
	});
});
