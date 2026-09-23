/**
 * What a removal asks the kernel for, and what each of its refusals leaves in the window (#9447).
 *
 * Every case is driven with the window's view slot the Cmd carries, because a refusal written back
 * over that slot is the whole reason the picker keeps the highlight and the process `<c-b> w` left
 * behind (#8265). The Cmd-to-handler wiring is proven where a whole kernel is standing —
 * `../proof/process-remove.unit.test.ts`.
 */

import {assert, describe, it} from "@effect/vitest";
import {ProcessId} from "@kampus/tuval/kernel/process/process";
import {Effect} from "effect";
import {removeHarness, windowId} from "./fixtures.ts";
import {runProcessRemoval} from "./remove.ts";
import {mountPicker, type PickerView, withRefusal} from "./view.ts";

const window = windowId("window-1");
const target = ProcessId.make("p-1");

const run = (options?: Parameters<typeof removeHarness>[0], view: PickerView = mountPicker()) =>
	Effect.gen(function* () {
		const harness = yield* removeHarness(options);
		const msgs = yield* runProcessRemoval(window, target, {view}).pipe(
			Effect.provide(harness.layer),
		);
		return {msgs, removed: harness.removed()};
	});

describe("a removal the kernel accepts", () => {
	it.effect("asks the kernel for that process and writes nothing to the desk", () =>
		Effect.gen(function* () {
			const answer = yield* run();
			assert.deepStrictEqual(answer.removed, [target]);
			// The row leaves the picker because the process left the table, and the next snapshot
			// carries that. A `window.setView` here would be the desk inventing state of its own.
			assert.deepStrictEqual(answer.msgs, []);
		}),
	);
});

describe("a removal the kernel refuses", () => {
	it.effect("shows the graph-declared refusal, which names the config as the way out", () =>
		Effect.gen(function* () {
			const answer = yield* run({refuseWith: "planned"});
			assert.deepStrictEqual(answer.removed, [target]);
			assert.deepStrictEqual(answer.msgs, [
				{
					type: "window.setView",
					windowId: window,
					view: withRefusal(mountPicker(), {_tag: "ProcessPlanned", processId: target}),
				},
			]);
		}),
	);

	it.effect("shows the durable failure, carrying the store's own reason", () =>
		Effect.gen(function* () {
			const answer = yield* run({refuseWith: "forget", reason: "manifest write refused"});
			assert.deepStrictEqual(answer.msgs, [
				{
					type: "window.setView",
					windowId: window,
					view: withRefusal(mountPicker(), {
						_tag: "RemoveFailed",
						processId: target,
						reason: "manifest write refused",
					}),
				},
			]);
		}),
	);

	it.effect("shows a process nothing knows about as gone, the arm attach already uses", () =>
		Effect.gen(function* () {
			const answer = yield* run({refuseWith: "missing"});
			assert.deepStrictEqual(answer.msgs, [
				{
					type: "window.setView",
					windowId: window,
					view: withRefusal(mountPicker(), {_tag: "ProcessGone", processId: target}),
				},
			]);
		}),
	);

	it.effect("writes the refusal over the slot it was handed, keeping the way back (#8265)", () =>
		Effect.gen(function* () {
			const answer = yield* run({refuseWith: "planned"}, {...mountPicker("p-9"), cursor: 3});
			assert.deepStrictEqual(answer.msgs, [
				{
					type: "window.setView",
					windowId: window,
					view: {
						cursor: 3,
						filter: null,
						previous: "p-9",
						refusal: {_tag: "ProcessPlanned", processId: target},
					},
				},
			]);
		}),
	);
});
