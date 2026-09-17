/**
 * `lane seats` — the pre-claim read: what it answers over a full root, one under the cap and one
 * that will not list, and that none of the three writes.
 *
 * The claim reader is injected the way `concurrency.unit.test.ts` injects it, so every row states
 * which lanes a driver holds with no board at all.
 */
import {Effect, type FileSystem, type Path} from "effect";
import {describe, expect, it} from "vitest";
import type {Read} from "../config/read-key.ts";
import {fakeFs} from "../fakes.test-support.ts";
import type {VerbOutcome} from "../verb.ts";
import type {ClaimHold, ClaimHoldReader} from "./claim-hold.ts";
import {LANE_UNREADABLE} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {runSeats} from "./seats-verb.ts";
import {DEFAULT_LANES_ROOT as ROOT} from "./store.ts";

/** The instant every row measures `retryAfter` from, so the answer reads the same twice over. */
const NOW = "2026-09-11T00:00:00.000Z";

const capped = (value: number | null): Read<number | null> => ({
	_tag: "Value",
	value,
	note: "test",
});

/** A root listing the given lanes, each holding a freshly booted machine — every one folds `active`. */
const rootOf = (...lanes: ReadonlyArray<string>) =>
	fakeFs({
		dirs: {[ROOT]: [...lanes]},
		directories: [ROOT],
		files: Object.fromEntries(
			lanes.map((id) => [`${ROOT}/${id}/workflow.json`, coderTemplateText()]),
		),
	});

/** The lanes a driver holds, by key; every other lane reads unclaimed. */
const claims = (...held: ReadonlyArray<string>): ClaimHoldReader<never> => {
	const holders = new Set(held);
	return (lane) =>
		Effect.succeed(
			(holders.has(lane)
				? {_tag: "Claimed", token: `lane:session:${lane}`}
				: {_tag: "Unclaimed"}) as ClaimHold,
		);
};

/** The board would not answer for this lane's claim — UNKNOWN, so the seat stays held. */
const unreadableClaims: ClaimHoldReader<never> = () =>
	Effect.succeed({_tag: "Unknown", reason: "the API answered 502"});

const run = (
	fs: ReturnType<typeof fakeFs>,
	eff: Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path>,
) => Effect.runPromise(Effect.provide(eff, fs.layer));

describe("a root holding as many claimed lanes as the cap allows", () => {
	it("answers full at exit 0 rather than refusing, and writes nothing", async () => {
		const fs = rootOf("7000", "7001");

		const out = await run(
			fs,
			runSeats({root: ROOT, cap: capped(2), now: NOW, claimed: claims("7000", "7001")}),
		);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "full",
			cap: 2,
			held: 2,
			free: 0,
			// Ten minutes past NOW — one pass of the driver's own loop, the dispatch budget.
			retryAfter: "2026-09-11T00:10:00.000Z",
			claimed: ["7000", "7001"],
			unaccountable: [],
			idle: [],
		});
		expect(fs.written.size).toBe(0);
	});

	it("says a boot would take 51, because that refusal is still lane open's to give", async () => {
		const fs = rootOf("7000");

		const out = await run(
			fs,
			runSeats({root: ROOT, cap: capped(1), now: NOW, claimed: claims("7000")}),
		);

		expect(out.stderr.join(" ")).toContain("refused at 51");
		expect(out.stderr.join(" ")).toContain("read again no sooner than 2026-09-11T00:10:00.000Z");
		expect(fs.written.size).toBe(0);
	});
});

describe("a root under the cap", () => {
	it("answers free with the seats left, and writes nothing", async () => {
		const fs = rootOf("7000", "7001");

		const out = await run(
			fs,
			runSeats({root: ROOT, cap: capped(5), now: NOW, claimed: claims("7000")}),
		);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "free",
			cap: 5,
			held: 1,
			free: 4,
			// Nothing to wait for where a seat is open — a retry instant here would be a wait nobody owes.
			retryAfter: null,
			claimed: ["7000"],
			idle: ["7001"],
		});
		expect(fs.written.size).toBe(0);
	});

	it("counts a lane no read can account for as held, and names it apart from a claimed one", async () => {
		const fs = rootOf("7000", "7001");

		const out = await run(
			fs,
			runSeats({root: ROOT, cap: capped(5), now: NOW, claimed: unreadableClaims}),
		);

		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "free",
			held: 2,
			free: 3,
			claimed: [],
			unaccountable: ["7000", "7001"],
		});
		expect(out.stderr.join(" ")).toContain("no read can account for");
		expect(fs.written.size).toBe(0);
	});

	it("answers uncapped with a null free where the repo declares no cap", async () => {
		const fs = rootOf("7000");

		const out = await run(
			fs,
			runSeats({root: ROOT, cap: capped(null), now: NOW, claimed: claims("7000")}),
		);

		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "uncapped",
			cap: null,
			held: 1,
			free: null,
		});
		expect(fs.written.size).toBe(0);
	});

	it("answers free over a root that is not there at all — an absent root holds no lanes", async () => {
		const fs = fakeFs({});

		const out = await run(fs, runSeats({root: ROOT, cap: capped(2), now: NOW, claimed: claims()}));

		expect(JSON.parse(out.stdout)).toMatchObject({answer: "free", held: 0, free: 2});
		expect(fs.written.size).toBe(0);
	});
});

describe("a root that cannot be read", () => {
	it("refuses at 11 with no answer on stdout — the count is UNKNOWN, never free", async () => {
		const fs = fakeFs({dirs: {[ROOT]: null}, directories: [ROOT]});

		const out = await run(fs, runSeats({root: ROOT, cap: capped(2), now: NOW, claimed: claims()}));

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join(" ")).toContain("UNKNOWN, never zero");
		expect(fs.written.size).toBe(0);
	});

	it("refuses at 11 when the cap itself did not read, before it lists anything", async () => {
		const fs = rootOf("7000");

		const out = await run(
			fs,
			runSeats({
				root: ROOT,
				cap: {_tag: "Refused", reason: ".fabrika.jsonc is not JSON"},
				now: NOW,
				claimed: claims("7000"),
			}),
		);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join(" ")).toContain("how many lanes this repo allows is UNKNOWN");
		expect(fs.written.size).toBe(0);
	});
});
