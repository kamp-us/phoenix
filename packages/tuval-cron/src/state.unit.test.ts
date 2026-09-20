/**
 * The window's reading of a cron, tested where it is decided. `cronView` is a pure function of
 * state, so what a person sees when they open a cron is a value here rather than a rendered tree —
 * and `./window.tsx` is left with nowhere to make a decision of its own.
 */

// `ProcessId` is a type-only brand — a plain string at runtime — and `ProcessId.make` is the only
// way to name one. The leaf under test imports it as a type and emits nothing; this test needs the
// value, which is why the kernel door appears in a test of a kernel-free module and nowhere else.
import {ProcessId} from "@kampus/tuval/authoring";
import {describe, expect, it} from "vitest";
import {
	type CronRun,
	type CronState,
	cronView,
	HISTORY,
	isCronState,
	runEvent,
	statusLine,
} from "./state.ts";

/** Seven in the morning, so the clock lines read the way the README spells them. */
const at = (hour: number, minute: number, second = 0): number =>
	new Date(2026, 8, 10, hour, minute, second).getTime();

const idle: CronState = {
	id: "morning-brief",
	cadence: "daily 07:00",
	child: null,
	startedAt: null,
	runs: [],
	ticks: 0,
};

const run = (hour: number, minute: number, ok: boolean, summary: string): CronRun => ({
	startedAt: at(hour, minute),
	ok,
	summary,
});

describe("what a window says about a cron that has never run", () => {
	it("names the cron, its schedule, and the spell its button stands in for", () => {
		const view = cronView(idle);
		expect(view.id).toBe("morning-brief");
		expect(view.cadence).toBe("daily 07:00");
		expect(view.spell).toBe(":morning-brief run");
		expect(view.status).toBe("idle");
		expect(view.running).toBe(false);
		expect(view.runs).toEqual([]);
		expect(view.emptyHistory).toBe("No runs yet.");
	});

	it("says the first run is still going rather than that nothing has happened", () => {
		const view = cronView({
			...idle,
			child: ProcessId.make("proc-1"),
			startedAt: at(7, 0, 12),
		});
		expect(view.running).toBe(true);
		expect(view.status).toBe("running since 07:00:12");
		expect(view.emptyHistory).toBe("No runs yet — the first one is still going.");
	});
});

describe("what a window says about a cron that has run", () => {
	it("lists every run newest first, carrying the brief the job actually wrote", () => {
		const view = cronView({
			...idle,
			runs: [
				run(7, 0, true, "3 PRs merged, 1 red on main"),
				run(6, 0, false, "ended without answering"),
			],
		});
		expect(view.runs.map((entry) => [entry.at, entry.ok, entry.summary])).toEqual([
			["07:00", true, "3 PRs merged, 1 red on main"],
			["06:00", false, "ended without answering"],
		]);
		expect(view.status).toBe("last run 07:00 · ok");
	});

	it("gives two runs in one minute two keys, so a list never collapses them", () => {
		const twice: CronState = {
			...idle,
			runs: [run(7, 0, true, "second"), run(7, 0, true, "first")],
		};
		const keys = cronView(twice).runs.map((entry) => entry.key);
		expect(new Set(keys).size).toBe(2);
	});

	it("shows at most HISTORY runs, whatever the state carries", () => {
		const many = Array.from({length: HISTORY + 5}, (_, index) => run(7, 0, true, `run ${index}`));
		expect(cronView({...idle, runs: many}).runs).toHaveLength(HISTORY);
	});

	it("draws the same status sentence the tile does", () => {
		const state = {...idle, runs: [run(7, 0, false, "boom")]};
		expect(cronView(state).status).toBe(statusLine(state));
	});
});

describe("the predicate the page admits this renderer through", () => {
	it("admits a cron's own state", () => {
		expect(isCronState(idle)).toBe(true);
		expect(
			isCronState({
				...idle,
				child: ProcessId.make("proc-1"),
				runs: [run(7, 0, true, "x")],
			}),
		).toBe(true);
	});

	it("refuses a state from a kernel that predates the window's two env fields", () => {
		// The honest answer to a skewed shape is the window's refusal placeholder, never a throw
		// inside React (ADR 0358).
		const {cadence: _cadence, ...older} = idle;
		expect(isCronState(older)).toBe(false);
	});

	it("refuses anything that is not a state at all", () => {
		expect(isCronState(null)).toBe(false);
		expect(isCronState("morning-brief")).toBe(false);
		expect(isCronState({...idle, runs: [{startedAt: "soon"}]})).toBe(false);
	});
});

describe("the event the Run now control sends", () => {
	it("is the arrival `:<id> run` puts on the `run` in-port, so both reach one cell", () => {
		expect(runEvent()).toEqual({type: "run", payload: {}});
	});

	it("is built fresh each time, so no caller holds a shared object", () => {
		expect(runEvent()).not.toBe(runEvent());
	});
});
