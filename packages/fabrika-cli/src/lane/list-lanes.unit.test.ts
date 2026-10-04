/**
 * What a lanes root lists as lanes — the one enumeration `lane seats`, `lane stale` and
 * `lane reconcile` share — over a root holding one real lane beside entries that are not lanes.
 *
 * `.DS_Store` is a file, so reading `.DS_Store/workflow.json` fails `ENOTDIR` on a real platform,
 * which is not `NotFound`. The fixture states that read as unreadable rather than absent, because
 * that failure is what used to turn the file into an unaccountable seat.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import type {ClaimHold, ClaimHoldReader} from "./claim-hold.ts";
import {seatsIn} from "./concurrency.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {runReconcile} from "./reconcile-verb.ts";
import {runStale} from "./stale-verb.ts";
import {listLanes, DEFAULT_LANES_ROOT as ROOT} from "./store.ts";

const NOW = "2026-09-01T12:00:00.000Z";
const TEMPLATE = "templates/coder.workflow.json";
const LANE = "7000";

/** One `ISSUE.WIP` — the lane is booted and being driven, so it folds `active`. */
const ACTIVE_LOG = `${JSON.stringify({task: "issue", event: "ISSUE.WIP", at: "2026-09-01T11:00:00.000Z"})}\n`;

/** A root holding one claimed active lane, a `.DS_Store` file, a plain file and an empty directory. */
const cluttered = (extra: FakeFsOptions = {}) =>
	fakeFs({
		files: {
			[TEMPLATE]: coderTemplateText(),
			[`${ROOT}/${LANE}/workflow.json`]: coderTemplateText(),
			[`${ROOT}/${LANE}/events.jsonl`]: ACTIVE_LOG,
			[`${ROOT}/.DS_Store`]: "\u0000\u0000\u0000\u0001Bud1",
			[`${ROOT}/notes.txt`]: "scratch",
			...extra.files,
		},
		dirs: {[ROOT]: [".DS_Store", LANE, "notes.txt", "stray"], ...extra.dirs},
		directories: [ROOT, `${ROOT}/${LANE}`, `${ROOT}/stray`, ...(extra.directories ?? [])],
		unreadable: [
			`${ROOT}/.DS_Store/workflow.json`,
			`${ROOT}/notes.txt/workflow.json`,
			...(extra.unreadable ?? []),
		],
		...(extra.unstatable === undefined ? {} : {unstatable: extra.unstatable}),
	});

const claims =
	(...held: ReadonlyArray<string>): ClaimHoldReader<never> =>
	(lane) =>
		Effect.succeed(
			(held.includes(lane)
				? {_tag: "Claimed", token: `lane:session:${lane}`}
				: {_tag: "Unclaimed"}) as ClaimHold,
		);

const run = <A>(
	fs: ReturnType<typeof fakeFs>,
	eff: Effect.Effect<A, never, FileSystem.FileSystem | Path.Path>,
): Promise<A> => Effect.runPromise(Effect.provide(eff, fs.layer));

const keys = (stdout: string): ReadonlyArray<string> =>
	(JSON.parse(stdout) as {lanes: ReadonlyArray<{key: string}>}).lanes.map((row) => row.key);

describe("listLanes", () => {
	it("keeps directories and drops files and dot-prefixed names", async () => {
		const fs = cluttered({directories: [`${ROOT}/.git`], dirs: {[ROOT]: [".git", "stray", LANE]}});
		const listed = await run(fs, Effect.result(listLanes(ROOT)));

		expect(listed).toEqual(Result.succeed([LANE, "stray"]));
	});

	it("fails on a root it cannot list, never answering an empty list", async () => {
		const fs = fakeFs({directories: [ROOT]});
		const listed = await run(fs, Effect.result(listLanes(ROOT)));

		expect(Result.isFailure(listed)).toBe(true);
	});

	it("keeps an entry whose kind it cannot stat, so the lane read still judges it", async () => {
		const fs = cluttered({dirs: {[ROOT]: [LANE, "7001"]}, unstatable: [`${ROOT}/7001`]});
		const listed = await run(fs, Effect.result(listLanes(ROOT)));

		expect(listed).toEqual(Result.succeed([LANE, "7001"]));
	});
});

describe("entries that are not lanes hold no seat", () => {
	it("counts only the real lane beside a .DS_Store file, a plain file and an empty directory", async () => {
		const counted = await run(cluttered(), seatsIn(ROOT, claims(LANE)));

		expect(counted).toEqual({_tag: "Counted", seats: [{lane: LANE, held: "claimed"}], idle: []});
	});

	it("still counts an unstatable entry whose record will not read as unaccountable", async () => {
		const fs = cluttered({
			dirs: {[ROOT]: [LANE, "7001"]},
			unstatable: [`${ROOT}/7001`],
			unreadable: [`${ROOT}/7001/workflow.json`],
		});
		const counted = await run(fs, seatsIn(ROOT, claims(LANE)));

		expect(counted).toEqual({
			_tag: "Counted",
			seats: [
				{lane: LANE, held: "claimed"},
				{lane: "7001", held: "unaccountable"},
			],
			idle: [],
		});
	});

	it("still counts a lane directory whose workflow.json cannot be read as unaccountable", async () => {
		const fs = cluttered({
			dirs: {[ROOT]: [LANE, "7001"]},
			directories: [`${ROOT}/7001`],
			unreadable: [`${ROOT}/7001/workflow.json`],
		});
		const counted = await run(fs, seatsIn(ROOT, claims(LANE)));

		expect(counted).toMatchObject({
			seats: [
				{lane: LANE, held: "claimed"},
				{lane: "7001", held: "unaccountable"},
			],
		});
	});
});

describe("the sweeps list the root the same way", () => {
	it("lane stale reports the real lane and no row for the non-lane entries", async () => {
		const out = await run(
			cluttered(),
			runStale({roots: [ROOT], olderThanMinutes: null, now: NOW, claims: null}),
		);

		expect(out.code).toBe(0);
		expect(keys(out.stdout)).toEqual([LANE]);
	});

	it("lane reconcile reports the real lane and no row for the non-lane entries", async () => {
		const out = await run(
			cluttered(),
			runReconcile({
				roots: [{root: ROOT, templatePaths: [TEMPLATE]}],
				check: true,
				now: NOW,
				closures: () => Effect.succeed({_tag: "Unknown", reason: "not asked in this test"}),
			}),
		);

		expect(out.code).toBe(0);
		expect(keys(out.stdout)).toEqual([LANE]);
	});
});
