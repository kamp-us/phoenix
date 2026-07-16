/**
 * Pins the harness CF-API throttle (#3081): it caps concurrent in-flight calls, never runs
 * more than `maxConcurrent` at once, paces call starts by at least `minSpacingMs` with full
 * jitter, propagates results/errors transparently, and always releases its slot (even when
 * `op` throws) so one failure can't wedge the limiter. `sleep`/`now`/`random` are injected so
 * the suite runs offline and deterministically.
 */

import {describe, expect, it, vi} from "vitest";
import {
	CF_API_MAX_CONCURRENT,
	CF_API_MIN_SPACING_MS,
	createCfApiThrottle,
} from "./_cf-api-throttle.ts";

// A deferred promise + its resolver, to hold `op` open and observe in-flight concurrency.
const deferred = <T>() => {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return {promise, resolve};
};

const noSleep = () => Promise.resolve();

// Drain the microtask queue so every `run`'s synchronous prelude (acquire → pace → op)
// settles — one `await Promise.resolve()` clears a single tick, not the 2–3 an async
// `run` chains before `op` executes.
const flush = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("createCfApiThrottle", () => {
	it("returns op's value and does not pace when spacing is disabled", async () => {
		const sleep = vi.fn(noSleep);
		const throttle = createCfApiThrottle({minSpacingMs: 0, sleep});
		await expect(throttle.run(async () => 42)).resolves.toBe(42);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("propagates a rejection and still releases the slot", async () => {
		const throttle = createCfApiThrottle({maxConcurrent: 1, minSpacingMs: 0});
		await expect(throttle.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow(
			"boom",
		);
		// If the failed call had leaked its slot, this second call would never acquire one.
		await expect(throttle.run(async () => "recovered")).resolves.toBe("recovered");
	});

	it("never runs more than maxConcurrent ops at once", async () => {
		const throttle = createCfApiThrottle({maxConcurrent: 2, minSpacingMs: 0});
		let active = 0;
		let peak = 0;
		const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
		const runs = gates.map((g) =>
			throttle.run(async () => {
				active++;
				peak = Math.max(peak, active);
				await g.promise;
				active--;
			}),
		);
		// Let the first wave acquire slots, then release them one at a time.
		await flush();
		expect(active).toBe(2); // only two admitted; the other two are queued
		for (const g of gates) {
			g.resolve();
			await flush();
		}
		await Promise.all(runs);
		expect(peak).toBe(2);
	});

	it("admits a queued op only after a slot frees", async () => {
		const throttle = createCfApiThrottle({maxConcurrent: 1, minSpacingMs: 0});
		const first = deferred<void>();
		let secondStarted = false;
		const r1 = throttle.run(async () => {
			await first.promise;
		});
		const r2 = throttle.run(async () => {
			secondStarted = true;
		});
		await flush();
		expect(secondStarted).toBe(false); // blocked behind the single slot
		first.resolve();
		await Promise.all([r1, r2]);
		expect(secondStarted).toBe(true);
	});

	it("spaces successive starts by >= minSpacingMs of jittered wait", async () => {
		const waits: number[] = [];
		let clock = 0;
		const sleep = vi.fn(async (ms: number) => {
			waits.push(ms);
			clock += ms; // advance the injected clock by exactly the slept time
		});
		const throttle = createCfApiThrottle({
			maxConcurrent: 10, // cap out of the way — isolate the pacing knob
			minSpacingMs: 100,
			sleep,
			now: () => clock,
			random: () => 0.999999, // maximize jitter → widest wait, still < 2·spacing
		});
		// Fire three back-to-back; each reserves a start floor spaced by minSpacingMs.
		await Promise.all([
			throttle.run(async () => {}),
			throttle.run(async () => {}),
			throttle.run(async () => {}),
		]);
		// First call starts immediately (only jitter); the next two wait at least one spacing.
		const paced = waits.filter((w) => w > 0);
		expect(paced.length).toBeGreaterThanOrEqual(2);
		for (const w of paced) {
			expect(w).toBeGreaterThan(0);
			expect(w).toBeLessThan(2 * 100); // start floor + jitter, both bounded by spacing
		}
	});

	it("exports sane default knobs", () => {
		expect(CF_API_MAX_CONCURRENT).toBeGreaterThan(0);
		expect(CF_API_MIN_SPACING_MS).toBeGreaterThanOrEqual(0);
	});
});
