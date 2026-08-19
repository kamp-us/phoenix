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
		await flush();
		expect(active).toBe(2);
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
		expect(secondStarted).toBe(false);
		first.resolve();
		await Promise.all([r1, r2]);
		expect(secondStarted).toBe(true);
	});

	it("spaces successive starts by >= minSpacingMs of jittered wait", async () => {
		const waits: number[] = [];
		let clock = 0;
		const sleep = vi.fn(async (ms: number) => {
			waits.push(ms);
			clock += ms;
		});
		const throttle = createCfApiThrottle({
			maxConcurrent: 10, // cap out of the way — isolate the pacing knob
			minSpacingMs: 100,
			sleep,
			now: () => clock,
			random: () => 0.999999, // maximize jitter → widest wait, still < 2·spacing
		});
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

// #3548 round 2 — the defects PR #4033's merge-queue ejection exposed.
describe("start-pacing does not consume the concurrency cap", () => {
	it("lets a call whose paced start has arrived run while another is still waiting for its start", async () => {
		// `pace()` used to sleep INSIDE the slot, so with one slot the first call's start-pacing
		// blocked every other call for its whole wait — the rate limiter eating the concurrency
		// limiter. Here the (never-resolving) pacer must not stop the second call from running.
		let holdPacing = () => {};
		const paced = new Promise<void>((r) => {
			holdPacing = r;
		});
		let sleeps = 0;
		const throttle = createCfApiThrottle({
			maxConcurrent: 1,
			minSpacingMs: 100,
			sleep: () => (sleeps++ === 0 ? paced : Promise.resolve()),
			now: () => 0,
			random: () => 0.5,
		});

		const first = throttle.run(async () => "first");
		let secondRan = false;
		const second = throttle.run(async () => {
			secondRan = true;
			return "second";
		});
		await flush();
		expect(secondRan).toBe(true); // under the old order this is false and `second` never resolves
		holdPacing();
		await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
	});

	it("reports the queueing it imposed through onQueued", async () => {
		let clock = 0;
		const throttle = createCfApiThrottle({
			maxConcurrent: 10,
			minSpacingMs: 100,
			sleep: async (ms) => {
				clock += ms;
			},
			now: () => clock,
			random: () => 0,
		});
		const queued: number[] = [];
		await throttle.run(
			async () => {},
			(ms) => queued.push(ms),
		);
		await throttle.run(
			async () => {},
			(ms) => queued.push(ms),
		);
		expect(queued).toHaveLength(2);
		expect(queued[0]).toBe(0);
		expect(queued[1]).toBe(100); // second waits one spacing — time the HARNESS imposed, not CF
	});
});

/**
 * Fill `maxConcurrent: 1`, hold it, then release the holder and let a fresh caller barge in
 * `offset` microtasks later. Returns the peak number of ops running CONCURRENTLY — asserting on
 * ops actually executing between the gates, not on the private `inFlight` counter, so the test
 * pins the property the cap exists for rather than an implementation detail.
 */
const peakUnderBargeAtOffset = async (offset: number): Promise<number> => {
	const throttle = createCfApiThrottle({maxConcurrent: 1, minSpacingMs: 0});
	let active = 0;
	let peak = 0;
	const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
	const runs = gates.map((g) =>
		throttle.run(async () => {
			active++;
			peak = Math.max(peak, active);
			await g.promise;
			active--;
		}),
	);
	await flush();
	gates[0]?.resolve();
	for (let i = 0; i < offset; i++) await Promise.resolve();
	const barger = throttle.run(async () => {
		active++;
		peak = Math.max(peak, active);
		active--;
	});
	await flush();
	gates[1]?.resolve();
	gates[2]?.resolve();
	await Promise.all([...runs, barger]);
	return peak;
};

describe("the concurrency cap holds under contention (the slot is handed over, not re-raced)", () => {
	// The old `inFlight--; waiters.shift()?.()` left a window in which a freshly-arriving call saw
	// a free slot and took it while the woken waiter also incremented — so `inFlight` drifted past
	// `maxConcurrent` and the cap stopped binding under exactly the load it exists for.
	//
	// SWEEP the arrival offset rather than pinning one number. The window is a few microtasks wide
	// and sits wherever `run`'s prelude happens to put it (against the pre-fix slot discipline it is
	// offset 1; a single added `await` anywhere in `run` moves it). A test pinned to one offset
	// silently stops regressing the moment the prelude shifts — and at offset 0 it never regressed
	// at all, since the barger reaches `acquireSlot` before the release has run and queues under
	// both implementations. Sweeping asserts the invariant at every arrival instant instead.
	it("does not admit a barging caller into a slot a waiter was just handed, at ANY arrival offset", async () => {
		const violations: Array<{offset: number; peak: number}> = [];
		for (let offset = 0; offset <= 12; offset++) {
			const peak = await peakUnderBargeAtOffset(offset);
			if (peak !== 1) violations.push({offset, peak});
		}
		expect(violations).toEqual([]);
	});
});
