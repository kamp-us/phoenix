/**
 * The other thing an open adds to the context the child is spawned under: the window it is being
 * opened into (#8758).
 *
 * It is proved here rather than in `./open.unit.test.ts` for the reason `./open-session.unit.test.ts`
 * is its own file — the failure is silent from the outside. A spawn that dropped the window produces
 * the same process, the same bind Msg and the same count, and only a kernel call the child makes
 * later would show it, as a `spawn` parented by nobody. So the harness reads the service back out of
 * the context it was handed and the assertion is on that.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {
	pickerHarness,
	processId,
	programId,
	programRow,
	shellProcessId,
	windowId,
} from "./fixtures.ts";
import {attachProcess, openProgram} from "./intent.ts";
import {runPickerIntent} from "./open.ts";

const window = windowId("window-7");
const rows = [programRow("claude", {label: "Claude"})];

const spawnsOf = (intent: ReturnType<typeof openProgram>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const harness = yield* pickerHarness(rows);
			yield* runPickerIntent(intent, {shellProcessId}).pipe(Effect.provide(harness.layer));
			return harness.spawns();
		}),
	);

describe("the window an open names its child", () => {
	it.effect("is the window the intent was for", () =>
		Effect.gen(function* () {
			const spawns = yield* spawnsOf(openProgram(window, programId("claude")));

			assert.lengthOf(spawns, 1);
			assert.strictEqual(
				spawns[0]?.window,
				"window-7",
				"a child spawned without its window has no window for the kernel to parent it from",
			);
		}),
	);

	it.effect("rides beside a picked session rather than instead of it", () =>
		Effect.gen(function* () {
			const spawns = yield* spawnsOf(
				openProgram(window, programId("claude"), {cwd: "/picked/repo", resume: "s-1"}),
			);

			assert.strictEqual(spawns[0]?.window, "window-7");
			assert.deepStrictEqual(spawns[0]?.session, {cwd: "/picked/repo", resume: "s-1"});
		}),
	);

	it.effect("is named by no attach, because an attach spawns nothing", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const harness = yield* pickerHarness(rows);
				yield* harness.seed("process-9", "claude");
				yield* runPickerIntent(attachProcess(window, processId("process-9")), {
					shellProcessId,
				}).pipe(Effect.provide(harness.layer));

				assert.lengthOf(harness.spawns(), 0);
			}),
		),
	);
});
