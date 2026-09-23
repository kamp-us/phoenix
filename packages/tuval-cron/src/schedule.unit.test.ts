/**
 * The cron-expression clock: what `schedule` means, what it refuses, and what a laptop that slept
 * through a fire time gets when it wakes.
 *
 * The program half is driven with `testProgram` and the injected clock, exactly as
 * `cron.unit.test.ts` drives the interval half — no kernel, no desk, no real timer. The Sub half is
 * driven against `armSchedule` directly with Vitest's fake timers and a `now` this file moves by
 * hand, because "the machine was asleep" is precisely a wall clock that jumped while no timer ran,
 * and nothing but a stated clock can say that.
 */

import {
	emit,
	type ShapeSource,
	STATUS_PORT,
	TITLE_PORT,
	testProgram,
} from "@kampus/tuval-sdk/authoring";
import {ClientId, claudeSession, WorkspaceId} from "@kampus-apps/tuval/sessions";
import {afterEach, describe, expect, it, vi} from "vitest";
import {type CronOptions, cron, cronProgram} from "./cron.ts";
import {armSchedule, humanize, parseSchedule} from "./schedule.ts";

/** Thursday, 10 September 2026, 07:00:12 local — the same instant `cron.unit.test.ts` pins. */
const SEVEN = new Date(2026, 8, 10, 7, 0, 12).getTime();

const at = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
	new Date(year, month - 1, day, hour, minute, 0, 0).getTime();

const job = (): ShapeSource =>
	claudeSession({
		cwd: "/tmp/cron-test",
		scope: {
			workspace: WorkspaceId.make("tuval/test"),
			client: ClientId.make("tuval-desk"),
		},
	}) as ShapeSource;

const scheduled = (schedule: string): CronOptions => ({
	schedule,
	prompt: "what changed?",
	now: () => SEVEN,
});

describe("what a cron expression says the next fire is", () => {
	it("steps `*/10 * * * *` to the next ten-minute mark, strictly after", () => {
		const every10 = parseSchedule("*/10 * * * *");
		expect(every10.next(SEVEN)).toBe(at(2026, 9, 10, 7, 10));
		// Strictly after: sitting exactly on a mark gives the *next* one, never the same one twice.
		expect(every10.next(at(2026, 9, 10, 7, 10))).toBe(at(2026, 9, 10, 7, 20));
	});

	it("carries `0 7 * * *` to tomorrow when today's seven has already gone", () => {
		const daily = parseSchedule("0 7 * * *");
		expect(daily.next(SEVEN)).toBe(at(2026, 9, 11, 7, 0));
		expect(daily.next(at(2026, 9, 10, 6, 30))).toBe(at(2026, 9, 10, 7, 0));
	});

	it("skips the weekend for `0 9 * * 1-5`", () => {
		const weekdays = parseSchedule("0 9 * * 1-5");
		// Thursday morning, before nine: today.
		expect(weekdays.next(SEVEN)).toBe(at(2026, 9, 10, 9, 0));
		// Friday, after nine: Monday, not Saturday.
		expect(weekdays.next(at(2026, 9, 11, 10, 0))).toBe(at(2026, 9, 14, 9, 0));
	});

	it("skips a month that has no 31st for `0 0 31 * *`", () => {
		const last = parseSchedule("0 0 31 * *");
		expect(last.next(at(2026, 2, 1))).toBe(at(2026, 3, 31));
		// April has thirty days, so the 31st of March runs into the 31st of May.
		expect(last.next(at(2026, 4, 1))).toBe(at(2026, 5, 31));
	});

	it("waits for a leap year for `0 0 29 2 *`", () => {
		// 2026 and 2027 have no 29 February; 2028 does.
		expect(parseSchedule("0 0 29 2 *").next(at(2026, 3, 1))).toBe(at(2028, 2, 29));
	});
});

describe("a schedule cron refuses before it is ever armed", () => {
	it("refuses a malformed expression at `cron(...)`, not at the first tick", () => {
		expect(() => cron({...scheduled("not a cron"), job: job()})).toThrow(/not a cron expression/);
		expect(() => cron({...scheduled("0 99 * * *"), job: job()})).toThrow(/not a cron expression/);
		// The parser's own complaint survives the wrapper, because it says more than we would.
		expect(() => parseSchedule("0 99 * * *")).toThrow(/expected range 0-23/);
	});

	it("refuses both clocks at once, which the type already refuses", () => {
		// biome-ignore lint/plugin: the cast IS the subject — proving the runtime guard fires for the both-clocks shape the type already refuses means reaching the call past the compiler. Permanent: no upstream change removes a cast that is the assertion.
		const both = {
			everyMs: 60_000,
			schedule: "0 7 * * *",
			prompt: "what changed?",
		} as unknown as CronOptions;
		expect(() => cron({...both, job: job()})).toThrow(/never both/);
		expect(() => cronProgram(both)).toThrow(/never both/);
	});

	it("refuses a cron given neither clock, rather than silently never waking", () => {
		// biome-ignore lint/plugin: the cast IS the subject — proving the runtime guard fires for the no-clock shape the type already refuses means reaching the call past the compiler. Permanent: no upstream change removes a cast that is the assertion.
		expect(() => cronProgram({prompt: "what changed?"} as unknown as CronOptions)).toThrow(
			/give `everyMs`/,
		);
	});

	it("takes a well-formed expression, and a real job row, without complaint", () => {
		expect(() => cron({...scheduled("0 7 * * *"), job: job()})).not.toThrow();
	});
});

describe("what a schedule cron says on its tile", () => {
	it("humanizes the daily case and keeps the expression for everything else", () => {
		expect(humanize("0 7 * * *")).toBe("daily 07:00");
		expect(humanize("30 9 * * *")).toBe("daily 09:30");
		expect(humanize("0 9 * * 1-5")).toBe("0 9 * * 1-5");
		expect(humanize("*/10 * * * *")).toBe("*/10 * * * *");
	});

	it("publishes the cadence and an idle status on a fresh process", () => {
		expect(testProgram(cronProgram(scheduled("0 7 * * *"))).effects).toEqual([
			emit(TITLE_PORT, "cron · daily 07:00"),
			emit(STATUS_PORT, "idle"),
		]);
		expect(testProgram(cronProgram(scheduled("0 9 * * 1-5"))).effects).toContainEqual(
			emit(TITLE_PORT, "cron · 0 9 * * 1-5"),
		);
	});

	it("declares one Sub, keyed on the expression rather than on anything per-tick", () => {
		const subs = cronProgram(scheduled("0 7 * * *")).subs;
		expect(subs).toHaveLength(1);
		expect(subs[0]?.deps(testProgram(cronProgram(scheduled("0 7 * * *"))).state)).toEqual({
			schedule: "0 7 * * *",
		});
	});

	it("wakes the same way a tick does once it is woken", () => {
		const run = testProgram(cronProgram(scheduled("0 7 * * *"))).event({
			type: "tick",
		});
		expect(run.state.ticks).toBe(1);
		expect(run.effects.filter((effect) => effect.type === "spawn")).toHaveLength(1);
	});
});

describe("the armed timer, against a clock that moves", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/** A clock this file states, and the fake timers that only move when it says so. */
	const rig = (
		start: number,
		expression: string,
		onFire: (at: number, count: number) => void = () => {},
	) => {
		vi.useFakeTimers();
		let current = start;
		const fired: number[] = [];
		const stop = armSchedule(
			parseSchedule(expression),
			() => current,
			() => {
				fired.push(current);
				onFire(current, fired.length);
			},
		);
		return {
			fired,
			stop,
			/** Time passes with the timers, which is an awake machine. */
			pass: (ms: number) => {
				current += ms;
				vi.advanceTimersByTime(ms);
			},
			/** Time passed while no timer ran, which is a machine that was asleep. */
			sleep: (ms: number) => {
				current += ms;
			},
		};
	};

	it("fires on each mark and does not accumulate drift from a slow tick", () => {
		const clock = rig(at(2026, 9, 10, 7, 0), "*/10 * * * *");
		clock.pass(10 * 60_000);
		// The tick itself took half a second; the next fire is still the 07:20 mark, not 07:20:00.5.
		clock.pass(500);
		clock.pass(10 * 60_000 - 500);
		expect(clock.fired).toEqual([at(2026, 9, 10, 7, 10), at(2026, 9, 10, 7, 20)]);
		clock.stop();
	});

	it("fires once on waking from a sleep that covered several marks, not once per mark", () => {
		const clock = rig(at(2026, 9, 10, 7, 0), "*/10 * * * *");
		// Asleep from 07:00 to 09:05: twelve ten-minute marks went by with no timer running at all.
		clock.sleep(2 * 60 * 60_000 + 5 * 60_000);
		clock.pass(10 * 60_000);
		expect(clock.fired).toHaveLength(1);
		// And the aim after it is a mark still ahead, not a queue of the twelve that were missed — so
		// nothing more comes due on the next turn of the loop.
		clock.pass(1);
		expect(clock.fired).toHaveLength(1);
		clock.stop();
	});

	it("holds a fire years out in chunks instead of wrapping a 32-bit delay to zero", () => {
		const clock = rig(at(2026, 3, 1), "0 0 29 2 *");
		// Two years of waiting is a hundred-odd `setTimeout` maxima; none of them is a tick.
		clock.pass(30 * 24 * 60 * 60_000);
		expect(clock.fired).toEqual([]);
		clock.stop();
	});

	it("keeps the clock running when a tick throws, and does not swallow the throw", () => {
		const clock = rig(at(2026, 9, 10, 7, 0), "*/10 * * * *", (_at, count) => {
			if (count === 1) throw new Error("dispatch blew up");
		});
		// The error is the tick's, and it leaves the timer callback rather than being eaten here.
		expect(() => clock.pass(10 * 60_000)).toThrow("dispatch blew up");
		// …and the fire after the one that threw still lands, which is the whole point: a throwing
		// dispatch cannot stop this clock any more than it stops the `setInterval` half.
		clock.pass(10 * 60_000);
		expect(clock.fired).toEqual([at(2026, 9, 10, 7, 10), at(2026, 9, 10, 7, 20)]);
		clock.stop();
	});

	it("stops arming once the Sub is torn down", () => {
		const clock = rig(at(2026, 9, 10, 7, 0), "*/10 * * * *");
		clock.stop();
		clock.pass(60 * 60_000);
		expect(clock.fired).toEqual([]);
	});
});
