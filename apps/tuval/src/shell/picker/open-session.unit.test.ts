/**
 * The one thing an open carrying a session does differently: it adds `SessionOpening` to the
 * context the child is spawned under, and changes nothing else (epic #8070, ruling 2).
 *
 * `./open.unit.test.ts` holds the ordinary open. This file is the pair beside it, because the
 * failure worth catching is silent from the outside — a spawn that dropped the `{cwd, resume}`
 * produces the same process, the same bind Msg and the same count, and only the child's own boot
 * would know. So the harness reads the service back out of the context it was handed and the
 * assertion is on that.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {pickerHarness, programId, programRow, shellProcessId, windowId} from "./fixtures.ts";
import {openProgram} from "./intent.ts";
import {runPickerIntent} from "./open.ts";

const window = windowId("window-1");
const rows = [programRow("pi", {label: "Pi"})];

const spawnsFor = (session?: {readonly cwd: string; readonly resume: string}) =>
	Effect.scoped(
		Effect.gen(function* () {
			const harness = yield* pickerHarness(rows);
			yield* runPickerIntent(openProgram(window, programId("pi"), session), {
				shellProcessId,
			}).pipe(Effect.provide(harness.layer));
			return harness.spawns();
		}),
	);

describe("opening a program for a picked session", () => {
	it.effect("spawns one process carrying that session's cwd and resume id", () =>
		Effect.gen(function* () {
			const spawns = yield* spawnsFor({cwd: "/picked/repo", resume: "s-1"});

			assert.lengthOf(spawns, 1);
			assert.strictEqual(spawns[0]?.programId, "pi");
			assert.strictEqual(spawns[0]?.parent, shellProcessId);
			assert.deepStrictEqual(spawns[0]?.session, {cwd: "/picked/repo", resume: "s-1"});
		}),
	);

	it.effect("names no session on an ordinary open, so the child opens its own", () =>
		Effect.gen(function* () {
			const spawns = yield* spawnsFor();

			assert.lengthOf(spawns, 1);
			assert.isUndefined(spawns[0]?.session);
		}),
	);
});
