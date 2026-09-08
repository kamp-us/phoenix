/**
 * The cap `lane open` refuses past — what holds a seat, what frees one, and what is never counted.
 *
 * The claim reader is injected, so every row states which lanes a driver is holding with no board.
 */
import {Effect, type FileSystem, type Path} from "effect";
import {describe, expect, it} from "vitest";
import type {Read} from "../config/read-key.ts";
import {fakeFs} from "../fakes.test-support.ts";
import type {VerbOutcome} from "../verb.ts";
import type {ClaimHold, ClaimHoldReader} from "./claim-hold.ts";
import {CONCURRENCY_CAPPED, LANE_UNREADABLE} from "./codes.ts";
import {choreTemplateText, coderTemplateText} from "./fixtures.test-support.ts";
import {runOpen} from "./open-verb.ts";
import {
	DEFAULT_ARCHIVED_LANES_ROOT,
	DEFAULT_CHORES_ROOT,
	DEFAULT_LANES_ROOT as ROOT,
} from "./store.ts";

const TEMPLATE = "/pkg/src/lane/templates/coder.workflow.json";
const CHORE_TEMPLATE = "/pkg/src/lane/templates/chore.workflow.json";

const capped = (value: number | null): Read<number | null> => ({
	_tag: "Value",
	value,
	note: "test",
});

/** The events that walk the coder template all the way to `complete` — a lane whose seat is free. */
const SHIPPED_LOG = ["ISSUE.WIP", "ISSUE.DONE", "ISSUE.PASS", "ISSUE.DONE"]
	.map((event, index) =>
		JSON.stringify({task: "issue", event, at: `2026-09-0${index + 1}T00:00:00Z`}),
	)
	.join("\n");

/** A lane directory holding a freshly booted machine — folds to `active`. */
const lane = (root: string, id: string, log?: string) => ({
	[`${root}/${id}/workflow.json`]: coderTemplateText(),
	...(log === undefined ? {} : {[`${root}/${id}/events.jsonl`]: log}),
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

const options = (
	cap: Read<number | null>,
	claimed: ClaimHoldReader<never> = claims("7000", "7001"),
) => ({
	root: ROOT,
	lane: "42",
	templatePath: TEMPLATE,
	issue: 42,
	expectation: null,
	cap,
	claimed,
});

const run = (
	fs: ReturnType<typeof fakeFs>,
	eff: Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path>,
) => Effect.runPromise(Effect.provide(eff, fs.layer));

describe("a repo with no cap declared boots whatever it likes", () => {
	it("boots over two standing lanes when the cap is null", async () => {
		const fs = fakeFs({
			files: {[TEMPLATE]: coderTemplateText(), ...lane(ROOT, "1"), ...lane(ROOT, "2")},
			dirs: {[ROOT]: ["1", "2"]},
			directories: [ROOT],
		});
		const out = await run(fs, runOpen(options(capped(null))));

		expect(out.code).toBe(0);
		expect(fs.written.get(`${ROOT}/42/workflow.json`)).toBe(coderTemplateText());
	});

	it("boots against an unreadable lanes root, because nothing needs counting", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		expect((await run(fs, runOpen(options(capped(null))))).code).toBe(0);
	});
});

describe("a declared cap refuses the boot that would exceed it", () => {
	it("refuses at the cap, naming the cap, the count and every lane holding a seat", async () => {
		const fs = fakeFs({
			files: {[TEMPLATE]: coderTemplateText(), ...lane(ROOT, "7000"), ...lane(ROOT, "7001")},
			dirs: {[ROOT]: ["7001", "7000"]},
			directories: [ROOT],
		});
		const out = await run(fs, runOpen(options(capped(2))));

		expect(out.code).toBe(CONCURRENCY_CAPPED);
		expect(out.stderr.join("\n")).toContain("caps this repo at 2");
		expect(out.stderr.join("\n")).toContain("holds 2 claimed");
		expect(out.stderr.join("\n")).toContain("#7000, #7001");
		expect(fs.written.size).toBe(0);
	});

	it("boots below the cap", async () => {
		const fs = fakeFs({
			files: {[TEMPLATE]: coderTemplateText(), ...lane(ROOT, "7000")},
			dirs: {[ROOT]: ["7000"]},
			directories: [ROOT],
		});
		const out = await run(fs, runOpen(options(capped(2))));

		expect(out.code).toBe(0);
		expect(fs.written.get(`${ROOT}/42/workflow.json`)).toBe(coderTemplateText());
	});

	it("names no override flag — raising the config value is the only way past", async () => {
		const fs = fakeFs({
			files: {[TEMPLATE]: coderTemplateText(), ...lane(ROOT, "7000")},
			dirs: {[ROOT]: ["7000"]},
			directories: [ROOT],
		});
		const out = await run(fs, runOpen(options(capped(1))));

		expect(out.code).toBe(CONCURRENCY_CAPPED);
		expect(out.stderr.join("\n")).toContain("There is no override flag");
		expect(out.stderr.join("\n")).toContain("laneConcurrencyCap");
	});
});

describe("what frees a seat, and what never held one", () => {
	it("does not count a lane whose log folded it to done", async () => {
		const fs = fakeFs({
			files: {
				[TEMPLATE]: coderTemplateText(),
				...lane(ROOT, "7000"),
				...lane(ROOT, "7001", SHIPPED_LOG),
			},
			dirs: {[ROOT]: ["7000", "7001"]},
			directories: [ROOT],
		});
		const out = await run(fs, runOpen(options(capped(2))));

		expect(out.code).toBe(0);
	});

	it("does not count an archived lane — it sits under a sibling root", async () => {
		const fs = fakeFs({
			files: {
				[TEMPLATE]: coderTemplateText(),
				...lane(ROOT, "7000"),
				...lane(DEFAULT_ARCHIVED_LANES_ROOT, "7001"),
			},
			dirs: {[ROOT]: ["7000"], [DEFAULT_ARCHIVED_LANES_ROOT]: ["7001"]},
			directories: [ROOT, DEFAULT_ARCHIVED_LANES_ROOT],
		});
		const out = await run(fs, runOpen(options(capped(2))));

		expect(out.code).toBe(0);
	});

	it("does not count a chore lane, and never caps a chore boot", async () => {
		const fs = fakeFs({
			files: {
				[CHORE_TEMPLATE]: choreTemplateText(),
				...lane(ROOT, "7000"),
				...lane(ROOT, "7001"),
				[`${DEFAULT_CHORES_ROOT}/park-sweep/workflow.json`]: choreTemplateText(),
			},
			dirs: {[ROOT]: ["7000", "7001"], [DEFAULT_CHORES_ROOT]: ["park-sweep"]},
			directories: [ROOT, DEFAULT_CHORES_ROOT],
		});
		const out = await run(
			fs,
			runOpen({
				root: DEFAULT_CHORES_ROOT,
				lane: "leak-sweep",
				templatePath: CHORE_TEMPLATE,
				issue: null,
				expectation: null,
				cap: capped(2),
				claimed: claims("7000", "7001"),
			}),
		);

		expect(out.code).toBe(0);
		expect(fs.written.get(`${DEFAULT_CHORES_ROOT}/leak-sweep/workflow.json`)).toBe(
			choreTemplateText(),
		);
	});

	// A directory under the root with no workflow.json is not a lane, so it is not a seat — the same
	// read `lane reconcile` makes of a scratch directory.
	it("does not count a directory that holds no machine", async () => {
		const fs = fakeFs({
			files: {[TEMPLATE]: coderTemplateText(), ...lane(ROOT, "7000")},
			dirs: {[ROOT]: ["7000", "scratch"]},
			directories: [ROOT],
		});
		expect((await run(fs, runOpen(options(capped(2))))).code).toBe(0);
	});

	it("counts a lane whose machine will not compile — a seat nobody can account for", async () => {
		const fs = fakeFs({
			files: {
				[TEMPLATE]: coderTemplateText(),
				...lane(ROOT, "7000"),
				[`${ROOT}/7001/workflow.json`]: "{not json",
			},
			dirs: {[ROOT]: ["7000", "7001"]},
			directories: [ROOT],
		});
		const out = await run(fs, runOpen(options(capped(2))));

		expect(out.code).toBe(CONCURRENCY_CAPPED);
		expect(out.stderr.join("\n")).toContain("#7001 (unaccountable)");
	});
});

describe("only a lane somebody is driving holds a seat", () => {
	const two = {
		files: {[TEMPLATE]: coderTemplateText(), ...lane(ROOT, "7000"), ...lane(ROOT, "7001")},
		dirs: {[ROOT]: ["7000", "7001"]},
		directories: [ROOT],
	};

	it("counts an active lane a driver claims", async () => {
		const fs = fakeFs(two);
		const out = await run(fs, runOpen(options(capped(2), claims("7000", "7001"))));

		expect(out.code).toBe(CONCURRENCY_CAPPED);
		expect(out.stderr.join("\n")).toContain("holds 2 claimed — #7000, #7001");
	});

	it("does not count an active lane no driver claims", async () => {
		const fs = fakeFs(two);
		const out = await run(fs, runOpen(options(capped(2), claims("7000"))));

		expect(out.code).toBe(0);
		expect(fs.written.get(`${ROOT}/42/workflow.json`)).toBe(coderTemplateText());
	});

	it("counts a lane whose claim the board would not answer for", async () => {
		const fs = fakeFs(two);
		const out = await run(fs, runOpen(options(capped(2), unreadableClaims)));

		expect(out.code).toBe(CONCURRENCY_CAPPED);
		expect(out.stderr.join("\n")).toContain("#7000 (unaccountable), #7001 (unaccountable)");
	});

	it("names the idle count beside the claimed seats, so both numbers are on the refusal", async () => {
		const fs = fakeFs({
			files: {
				[TEMPLATE]: coderTemplateText(),
				...lane(ROOT, "7000"),
				...lane(ROOT, "7001"),
				...lane(ROOT, "7002"),
			},
			dirs: {[ROOT]: ["7000", "7001", "7002"]},
			directories: [ROOT],
		});
		const out = await run(fs, runOpen(options(capped(1), claims("7000"))));
		const said = out.stderr.join("\n");

		expect(out.code).toBe(CONCURRENCY_CAPPED);
		expect(said).toContain("caps this repo at 1 lane(s)");
		expect(said).toContain("holds 1 claimed — #7000");
		expect(said).toContain("2 further active lane(s)");
		expect(said).toContain("#7001, #7002");
		expect(fs.written.size).toBe(0);
	});

	it("says so when every other lane is claimed and none is idle", async () => {
		const fs = fakeFs(two);
		const out = await run(fs, runOpen(options(capped(2), claims("7000", "7001"))));

		expect(out.stderr.join("\n")).toContain(
			"No other lane under this root is active and unclaimed.",
		);
	});
});

describe("a cap that could not be read is UNKNOWN, never absent", () => {
	it("refuses when the config key did not resolve", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		const out = await run(
			fs,
			runOpen(options({_tag: "Refused", reason: "`laneConcurrencyCap` is not a positive integer"})),
		);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.size).toBe(0);
	});

	it("refuses when the lanes root exists and cannot be listed", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}, directories: [ROOT]});
		const out = await run(fs, runOpen(options(capped(2))));

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.join("\n")).toContain("to count the lanes standing against");
		expect(fs.written.size).toBe(0);
	});
});
