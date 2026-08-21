/** `lane stale` — the sweep across lanes, its per-lane rows, and the one thing it refuses. */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {Claimants} from "../build/claim.ts";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {LANE_UNREADABLE} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {runStale} from "./stale-verb.ts";
import {DEFAULT_CHORES_ROOT, DEFAULT_LANES_ROOT} from "./store.ts";

const NOW = "2026-08-17T12:00:00.000Z";
const minutesAgo = (n: number): string => new Date(Date.parse(NOW) - n * 60_000).toISOString();

const line = (event: string, at: string): string =>
	`${JSON.stringify({task: "issue", event: `ISSUE.${event}`, at})}\n`;

interface LaneFixture {
	readonly root?: string;
	readonly lane: string;
	readonly log?: string;
	readonly workflow?: string | null;
}

const tree = (lanes: ReadonlyArray<LaneFixture>, extra: FakeFsOptions = {}) => {
	const files: Record<string, string | null> = {};
	const dirs: Record<string, Array<string>> = {[DEFAULT_LANES_ROOT]: []};
	for (const {root = DEFAULT_LANES_ROOT, lane, log, workflow} of lanes) {
		const names = dirs[root] ?? [];
		names.push(lane);
		dirs[root] = names;
		const value = workflow === undefined ? coderTemplateText() : workflow;
		if (value !== null) files[`${root}/${lane}/workflow.json`] = value;
		if (log !== undefined) files[`${root}/${lane}/events.jsonl`] = log;
	}
	return fakeFs({
		files,
		dirs: {...dirs, ...extra.dirs},
		directories: [...Object.keys(dirs), ...(extra.directories ?? [])],
		...(extra.unreadable === undefined ? {} : {unreadable: extra.unreadable}),
		...(extra.unprobeable === undefined ? {} : {unprobeable: extra.unprobeable}),
	});
};

/**
 * The default sweep, run with the filesystem as its ONLY provided service.
 *
 * That is the offline claim, stated where a test can red it: the claim reader is the verb's one
 * network seam, `null` removes it, and a run that reached the board here would want a service this
 * environment does not carry.
 */
const sweep = (
	fs: ReturnType<typeof fakeFs>,
	options: {roots?: ReadonlyArray<string>; olderThanMinutes?: number; now?: string} = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runStale({
				roots: options.roots ?? [DEFAULT_LANES_ROOT],
				olderThanMinutes: options.olderThanMinutes ?? 60,
				now: options.now ?? NOW,
				claims: null,
			}),
			fs.layer,
		),
	);

/** The same sweep with a scripted board reader, and the log of every number it was asked about. */
const sweepWithClaims = (
	fs: ReturnType<typeof fakeFs>,
	claimants: (number: number) => Claimants,
	options: {roots?: ReadonlyArray<string>} = {},
) => {
	const asked: Array<number> = [];
	return Effect.runPromise(
		Effect.provide(
			runStale({
				roots: options.roots ?? [DEFAULT_LANES_ROOT],
				olderThanMinutes: 60,
				now: NOW,
				claims: (number) =>
					Effect.sync(() => {
						asked.push(number);
						return claimants(number);
					}),
			}),
			fs.layer,
		),
	).then((out) => ({out, asked}));
};

const HOLDER = {
	commentId: 9001,
	author: "agent",
	createdAt: minutesAgo(80),
	token: "build:s-dead:c1a4d6f8-1111-2222-3333-444455556666",
	session: "s-dead",
	authorized: true,
} as const;

const held: Claimants = {_tag: "Read", claimants: [HOLDER], adopts: [], holder: HOLDER};
const unclaimed: Claimants = {_tag: "Read", claimants: [], adopts: [], holder: null};

describe("lane stale", () => {
	it("reports a driven lane silent past the threshold as stale, with its state and age", async () => {
		const out = await sweep(tree([{lane: "5829", log: line("WIP", minutesAgo(76))}]));

		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer.lanes).toEqual([
			{
				key: "5829",
				root: DEFAULT_LANES_ROOT,
				stateValue: {pipeline: {issue: "build"}},
				status: "active",
				verdict: "stale",
				ageMinutes: 76,
				lastEventAt: minutesAgo(76),
			},
		]);
		expect(answer.summary.stale).toBe(1);
		expect(out.stderr.join("\n")).toContain("5829 (76m)");
	});

	it("reports a recently moved lane as moving", async () => {
		const out = await sweep(tree([{lane: "5825", log: line("WIP", minutesAgo(5))}]));

		expect(JSON.parse(out.stdout).lanes[0]).toMatchObject({verdict: "moving", ageMinutes: 5});
	});

	it("never calls a human park stale, however long it has sat", async () => {
		const log =
			line("WIP", minutesAgo(900)) +
			line("DONE", minutesAgo(880)) +
			line("PASS", minutesAgo(870)) +
			line("BLOCKED", minutesAgo(860));
		const out = await sweep(tree([{lane: "5832", log}]));

		expect(JSON.parse(out.stdout).lanes[0]).toMatchObject({
			verdict: "parked",
			stateValue: {pipeline: {issue: "human:cp-approval"}},
			ageMinutes: 860,
		});
	});

	it("never calls a finished lane stale", async () => {
		const log =
			line("WIP", minutesAgo(900)) +
			line("DONE", minutesAgo(880)) +
			line("PASS", minutesAgo(870)) +
			line("DONE", minutesAgo(860));
		const out = await sweep(tree([{lane: "5680", log}]));

		expect(JSON.parse(out.stdout).lanes[0]).toMatchObject({verdict: "terminal", status: "done"});
	});

	it("calls a lane with no events at all unstarted rather than fresh", async () => {
		const out = await sweep(tree([{lane: "5897"}]));

		expect(JSON.parse(out.stdout).lanes[0]).toMatchObject({
			verdict: "unstarted",
			ageMinutes: null,
			lastEventAt: null,
		});
	});

	it("answers zero lanes cleanly at exit 0, both for an empty root and an absent one", async () => {
		const empty = await sweep(tree([]));
		expect(empty.code).toBe(0);
		expect(JSON.parse(empty.stdout)).toMatchObject({
			summary: {stale: 0},
			lanes: [],
			scanned: [{root: DEFAULT_LANES_ROOT, present: true, lanes: 0}],
		});

		const absent = await sweep(fakeFs({files: {}}), {roots: [".fabrika/nowhere"]});
		expect(absent.code).toBe(0);
		expect(JSON.parse(absent.stdout).scanned).toEqual([
			{root: ".fabrika/nowhere", present: false, lanes: 0},
		]);
	});

	it("skips a directory under the root that holds no workflow.json", async () => {
		const out = await sweep(tree([{lane: "scratch", workflow: null}]));

		expect(JSON.parse(out.stdout)).toMatchObject({
			lanes: [],
			scanned: [{root: DEFAULT_LANES_ROOT, lanes: 0}],
		});
	});

	it("reports an unreadable lane as its own row and keeps sweeping the rest", async () => {
		const out = await sweep(
			tree([
				{lane: "1", workflow: '{"machine":{"states":{}}}'},
				{lane: "2", log: line("WIP", minutesAgo(90))},
			]),
		);

		expect(out.code).toBe(0);
		const {lanes, summary} = JSON.parse(out.stdout);
		expect(summary).toMatchObject({unreadable: 1, stale: 1});
		expect(lanes.map((row: {key: string}) => row.key)).toEqual(["2", "1"]);
		expect(lanes[1].reason).toContain("not the shape");
	});

	it("reports a lane whose timestamps do not parse as unreadable, never as moving", async () => {
		const out = await sweep(tree([{lane: "3", log: line("WIP", "whenever")}]));

		expect(JSON.parse(out.stdout).lanes[0]).toMatchObject({
			verdict: "unreadable",
			ageMinutes: null,
		});
	});

	it("keys a chore root's lanes the way a caller addresses them", async () => {
		const out = await sweep(
			tree([{root: DEFAULT_CHORES_ROOT, lane: "park-sweep", log: line("WIP", minutesAgo(90))}]),
			{roots: [DEFAULT_CHORES_ROOT]},
		);

		expect(JSON.parse(out.stdout).lanes[0]).toMatchObject({key: "chore:park-sweep"});
	});

	it("sweeps every root it is given and sorts the oldest silence first", async () => {
		const out = await sweep(
			tree([
				{lane: "10", log: line("WIP", minutesAgo(70))},
				{lane: "11", log: line("WIP", minutesAgo(400))},
				{root: DEFAULT_CHORES_ROOT, lane: "sweep", log: line("WIP", minutesAgo(200))},
			]),
			{roots: [DEFAULT_LANES_ROOT, DEFAULT_CHORES_ROOT]},
		);

		expect(JSON.parse(out.stdout).lanes.map((row: {key: string}) => row.key)).toEqual([
			"11",
			"chore:sweep",
			"10",
		]);
	});

	it("takes the threshold from the caller — the same tree answers differently", async () => {
		const fixture = () => tree([{lane: "12", log: line("WIP", minutesAgo(45))}]);

		expect(JSON.parse((await sweep(fixture(), {olderThanMinutes: 30})).stdout).summary.stale).toBe(
			1,
		);
		expect(JSON.parse((await sweep(fixture(), {olderThanMinutes: 60})).stdout).summary.stale).toBe(
			0,
		);
	});

	it("refuses a root that is there and cannot be listed — UNKNOWN, never a short list", async () => {
		const out = await sweep(
			fakeFs({files: {}, directories: [DEFAULT_LANES_ROOT], dirs: {[DEFAULT_LANES_ROOT]: null}}),
		);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("UNKNOWN");
	});

	it("refuses a negative threshold as a usage error", async () => {
		const out = await sweep(tree([]), {olderThanMinutes: -1});

		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
	});

	describe("--claims", () => {
		it("reads no board at all by default — no row carries a claim, and the summary says unasked", async () => {
			const out = await sweep(tree([{lane: "6669", log: line("WIP", minutesAgo(90))}]));
			const answer = JSON.parse(out.stdout);

			expect(answer.claims).toBeNull();
			expect(answer.lanes[0]).not.toHaveProperty("claims");
		});

		it("pairs a stale lane with the claim its dead builder left on the issue", async () => {
			const {out, asked} = await sweepWithClaims(
				tree([{lane: "6669", log: line("WIP", minutesAgo(90))}]),
				() => held,
			);
			const answer = JSON.parse(out.stdout);

			expect(asked).toEqual([6669]);
			expect(answer.lanes[0].claims).toEqual({
				state: "held",
				token: HOLDER.token,
				session: "s-dead",
				author: "agent",
				commentId: 9001,
			});
			expect(answer.claims).toEqual({paired: 1, held: 1, unclaimed: 0, unknown: 0});
			expect(out.stderr.join("\n")).toContain(`6669 (${HOLDER.token})`);
		});

		it("answers unknown on a board read that failed, never unclaimed", async () => {
			const {out} = await sweepWithClaims(
				tree([{lane: "6670", log: line("WIP", minutesAgo(90))}]),
				() => ({_tag: "Unknown", reason: "GitHub answered 502"}),
			);
			const answer = JSON.parse(out.stdout);

			expect(answer.lanes[0].claims).toEqual({
				state: "unknown",
				reason: "GitHub answered 502",
			});
			expect(answer.claims).toMatchObject({unknown: 1, unclaimed: 0});
			expect(out.stderr.join("\n")).toContain('UNKNOWN, never "unclaimed"');
		});

		it("asks about neither a terminal lane nor a chore lane — one drives no work, the other no issue", async () => {
			const done =
				line("WIP", minutesAgo(300)) +
				line("DONE", minutesAgo(290)) +
				line("PASS", minutesAgo(280)) +
				line("DONE", minutesAgo(270));
			const {out, asked} = await sweepWithClaims(
				tree([
					{lane: "6671", log: done},
					{lane: "6672", log: line("WIP", minutesAgo(90))},
					{root: DEFAULT_CHORES_ROOT, lane: "sweep", log: line("WIP", minutesAgo(90))},
				]),
				() => unclaimed,
				{roots: [DEFAULT_LANES_ROOT, DEFAULT_CHORES_ROOT]},
			);
			const answer = JSON.parse(out.stdout);
			const rows = Object.fromEntries(
				answer.lanes.map((row: {key: string; claims?: unknown}) => [row.key, row.claims]),
			);

			expect(asked).toEqual([6672]);
			expect(rows["6671"]).toBeUndefined();
			expect(rows["chore:sweep"]).toBeUndefined();
			expect(rows["6672"]).toEqual({state: "unclaimed"});
			expect(answer.claims).toEqual({paired: 1, held: 0, unclaimed: 1, unknown: 0});
		});
	});
});
