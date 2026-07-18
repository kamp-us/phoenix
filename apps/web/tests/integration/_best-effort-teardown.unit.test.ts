/**
 * Reproduces the #3515 recurrence condition at the unit level: a shared-stage teardown whose
 * underlying `Core.run` REJECTS (the escape past the inner `Effect.catchCause` — layer acquisition
 * or scope finalization) must not reject the caller. If it did, the vitest `globalSetup` teardown
 * promise would reject and red a green `test:integration` run, dequeuing a clean PR (#3515). The
 * wrapper's contract: swallow every rejection, report the leak once, always resolve.
 */

import {describe, expect, it, vi} from "vitest";
import {runBestEffortTeardown} from "./_best-effort-teardown.ts";

describe("runBestEffortTeardown", () => {
	it("resolves and reports the leak when the teardown thunk rejects (the #3515 escape)", async () => {
		const onLeak = vi.fn();
		const boom = new Error("Core.run rejected: state layer acquisition failed");

		await expect(
			runBestEffortTeardown(() => Promise.reject(boom), onLeak),
		).resolves.toBeUndefined();

		expect(onLeak).toHaveBeenCalledTimes(1);
		expect(onLeak).toHaveBeenCalledWith(boom);
	});

	it("resolves and never reports a leak when the teardown thunk succeeds (a clean run)", async () => {
		const onLeak = vi.fn();

		await expect(
			runBestEffortTeardown(() => Promise.resolve("destroyed"), onLeak),
		).resolves.toBeUndefined();

		expect(onLeak).not.toHaveBeenCalled();
	});

	it("swallows a non-Error rejection too (a raw FiberFailure string never escapes)", async () => {
		const onLeak = vi.fn();

		await expect(
			runBestEffortTeardown(() => Promise.reject("stage leaked"), onLeak),
		).resolves.toBeUndefined();

		expect(onLeak).toHaveBeenCalledWith("stage leaked");
	});
});
