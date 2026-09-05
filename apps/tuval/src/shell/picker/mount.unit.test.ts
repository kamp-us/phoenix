/**
 * Two claims about a mount. First, the picker carries nothing across one: mount it, change the
 * registry, mount it again, and the second mount shows the second registry — there is no cache to
 * invalidate because there is nothing to cache. Second, the attach route really is the Vim buffer
 * model's door: two windows over the process it binds share one state and keep two `view` slots.
 */

import {Effect, Stream} from "effect";
import {describe, expect, it} from "vitest";
import {ProcessId} from "../../process/process.ts";
import {testProcess} from "../window/fixtures.ts";
import {readEntries} from "./entries.ts";
import {pickerHarness, programRow, shellProcessId, windowId} from "./fixtures.ts";
import {pickerFrame} from "./frame.ts";
import {attachProcess} from "./intent.ts";
import {runPickerIntent} from "./open.ts";
import {mountPicker} from "./view.ts";

const window = windowId("window-1");

describe("a mount reads the world fresh", () => {
	it("a second mount after a registry change lists the new rows and none of the old", async () => {
		const listed = await Effect.runPromise(
			Effect.scoped(
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
			),
		);
		const [first, second] = listed;
		expect(first.programs.map((entry) => entry.label)).toEqual(["Counter"]);
		expect(second.programs.map((entry) => entry.label)).toEqual(["Pi", "Claude"]);

		// The frame is the mount's whole output, so the stale row cannot survive anywhere else.
		const frame = pickerFrame(window, second, mountPicker());
		expect(frame.groups[0]?.options.map((option) => option.detail)).toEqual(["pi", "claude"]);
		expect(frame.activeDescendant).toBe("picker-window-1-option-0");
	});

	it("a fresh mount starts at the top with no refusal, whatever the last one ended on", () => {
		expect(mountPicker()).toEqual({cursor: 0, refusal: null});
		expect(mountPicker()).not.toBe(mountPicker());
	});
});

describe("attaching gives one process a second window", () => {
	it("both windows read one state and each keeps its own view slot", async () => {
		const answer = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const harness = yield* pickerHarness([programRow("counter", {label: "Counter"})]);
					const id = yield* harness.seed("p-1", "counter");

					const bind = yield* runPickerIntent(attachProcess(windowId("window-2"), id), {
						shellProcessId,
					}).pipe(Effect.provide(harness.layer));

					const process = yield* testProcess<{readonly count: number}>(ProcessId.make("p-1"), {
						count: 0,
					});
					const one = yield* process.window(windowId("window-1"), {scroll: 0});
					const two = yield* process.window(windowId("window-2"), {scroll: 0});

					yield* process.commit({count: 7});
					yield* two.setView({scroll: 42});

					const seen = yield* Effect.all(
						[Stream.runHead(one.readProcess), Stream.runHead(two.readProcess)],
						{concurrency: 2},
					);
					return {bind, seen, views: [one.view(), two.view()]};
				}),
			),
		);

		expect(answer.bind).toEqual([{type: "window.bind", windowId: "window-2", processId: "p-1"}]);
		expect(
			answer.seen.map((head) =>
				head._tag === "Some" && head.value._tag === "Live" ? head.value.state : null,
			),
		).toEqual([{count: 7}, {count: 7}]);
		expect(answer.views).toEqual([{scroll: 0}, {scroll: 42}]);
	});
});
