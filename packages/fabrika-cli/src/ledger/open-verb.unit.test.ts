import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {comments, GATEWAY, GIT_DIRS} from "../build/fixtures.test-support.ts";
import {errOut, fakeFs, fakeSeams, okOut, type Scripted} from "../fakes.test-support.ts";
import {
	CLAIM_NOT_MINE,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	REGION_UNRESOLVABLE,
	STALE_GROUND,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	backlogPage,
	CLAIMED,
	DIR,
	EXCLUDE_PATH,
	env,
	epic,
	issueRows,
	subIssues,
	TOKEN,
} from "./fixtures.test-support.ts";
import {runOpen} from "./open-verb.ts";
import {manifestPath, parseManifest, parseRunRecord, runJsonPath} from "./run.ts";

const SHA = "03135b9188d2be6c0a4b7bd0b7a3ff9c53f0f2b1";

const EPIC_READ = /^gh api repos\/o\/r\/issues\/4300$/;
const TREE = /^git rev-parse --path-format=absolute/;
const SUBS = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300\/sub_issues/;
const CYCLE = /^gh api repos\/o\/r\/contents\/product-development-cycle\.md$/;
const BACKLOG = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\?state=open/;
const SEARCH = /^gh api --paginate search\/issues/;
const REV_LIST = /^git rev-list --count/;

const GROUND: ReadonlyArray<Scripted> = [
	[/^git remote$/, okOut("origin\n")],
	[/^git fetch --quiet origin main$/, okOut("")],
	[/^git rev-parse --verify --quiet origin\/main/, okOut(`${SHA}\n`)],
	[REV_LIST, okOut("0\n")],
];

const CLEAN: ReadonlyArray<Scripted> = [
	[EPIC_READ, epic()],
	[TREE, GIT_DIRS],
	...CLAIMED,
	...GROUND,
	[SUBS, subIssues()],
	[CYCLE, okOut("{}")],
	[BACKLOG, backlogPage([4180, "queue view for reports"])],
	[SEARCH, issueRows()],
];

const run = (
	script: ReadonlyArray<Scripted>,
	files: Readonly<Record<string, string | null>> = {},
) => {
	const shell = fakeSeams(script);
	const fs = fakeFs({files});
	return Effect.runPromise(
		Effect.provide(
			runOpen({number: 4300, token: TOKEN, repo: null, cwd: "/repo", env}),
			Layer.mergeAll(shell.layer, fs.layer),
		),
	).then((outcome) => ({outcome, written: fs.written, calls: shell.calls}));
};

describe("runOpen", () => {
	it("allocates the run, decides the mode, and prints the ground it proved", async () => {
		const {outcome, written} = await run(CLEAN);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			answer: "opened",
			epic: 4300,
			run: "4300-c1a4d6f8",
			mode: "fresh",
			dir: DIR,
			children: [],
			cycleDoc: "present",
			candidates: {outcome: "candidates"},
		});
		expect(JSON.parse(outcome.stdout).bodyDigest).toMatch(/^[0-9a-f]{12}$/);
		expect(parseRunRecord(written.get(runJsonPath(DIR)) ?? "")).toMatchObject({
			epic: 4300,
			mode: "fresh",
			cycleDoc: "present",
		});
	});

	/**
	 * The manifest is the epic's WHOLE child set, not this run's additions — which is what makes a
	 * re-plan's topology check correct. Without the seed, a retained child is a dangling ref if named
	 * and an orphan at the gate if omitted, with no third option.
	 */
	it("seeds the manifest with the epic's existing children, ids and all", async () => {
		const {outcome, written} = await run([
			...CLEAN.filter(([pattern]) => pattern !== SUBS),
			[SUBS, subIssues({number: 4301, id: 90210, labels: ["type:feature", "p1"]})],
		]);
		expect(JSON.parse(outcome.stdout).children).toEqual([
			{number: 4301, title: "child 4301", labels: ["type:feature", "p1"]},
		]);
		expect(parseManifest(written.get(manifestPath(DIR)) ?? "")).toEqual([
			{
				number: 4301,
				id: 90210,
				title: "child 4301",
				type: "type:feature",
				priority: "p1",
				readyFor: null,
				stories: null,
				containment: null,
				linked: true,
				mintedThisRun: false,
			},
		]);
	});

	it("reads one plan heading as a re-plan", async () => {
		const {outcome} = await run([
			[EPIC_READ, epic({body: "brief\n\n## Plan (plan-epic)\n\n### Summary\n\nold\n"})],
			...CLEAN.slice(1),
		]);
		expect(JSON.parse(outcome.stdout).mode).toBe("re-plan");
	});

	/** Two headings: the mode cannot be decided, and guessing is what corrupted epics in v1. */
	it("refuses two plan headings rather than guessing the mode", async () => {
		const {outcome} = await run([
			[EPIC_READ, epic({body: "## Plan (plan-epic)\n\na\n\n## Plan (plan-epic)\n\nb\n"})],
			...CLEAN.slice(1),
		]);
		expect(outcome.code).toBe(REGION_UNRESOLVABLE);
		expect(outcome.stdout).toBe("");
	});

	it("registers the run root in this tree's git exclude", async () => {
		const {written} = await run(CLEAN);
		expect(written.get(EXCLUDE_PATH)).toBe(".fabrika-plan/\n");
	});

	it("keeps a staged plan across a re-open — a resume is not a reset", async () => {
		const {written} = await run(CLEAN, {[`${DIR}/plan.md`]: "## Plan (plan-epic)\n"});
		expect(written.has(`${DIR}/plan.md`)).toBe(false);
	});

	it("re-seeds a resumed run without forgetting which children it minted", async () => {
		const {written} = await run(
			[
				...CLEAN.filter(([pattern]) => pattern !== SUBS),
				[SUBS, subIssues({number: 4301, id: 90210})],
			],
			{
				[manifestPath(DIR)]: `${JSON.stringify({
					number: 4301,
					id: 90210,
					title: "child 4301",
					linked: false,
					mintedThisRun: true,
				})}\n`,
			},
		);
		expect(parseManifest(written.get(manifestPath(DIR)) ?? "")).toMatchObject([
			{number: 4301, linked: true, mintedThisRun: true},
		]);
	});

	it("refuses a base proven behind origin/main", async () => {
		const {outcome} = await run([
			...CLEAN.filter(([pattern]) => pattern !== REV_LIST),
			[REV_LIST, okOut("47\n")],
		]);
		expect(outcome.code).toBe(STALE_GROUND);
		expect(outcome.stderr.at(-1)).toBe(
			"ledger open: base is 47 commit(s) behind origin/main — a plan derived here is derived on stale ground (#3330).",
		);
	});

	/** "I could not tell" is not "it is stale", and it is certainly not "it is fresh". */
	it("seats an unreadable freshness probe on 11, never on 20", async () => {
		const {outcome} = await run([
			...CLEAN.filter(([pattern]) => pattern !== REV_LIST),
			[REV_LIST, errOut("fatal: bad revision")],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses an issue that is not a type:epic", async () => {
		const {outcome} = await run([
			[EPIC_READ, epic({labels: [{name: "type:feature"}]})],
			...CLEAN.slice(1),
		]);
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(
			"ledger open: #4300 is not a type:epic — refusing to plan it.",
		);
	});

	it("refuses a proven-absent epic on 7", async () => {
		const {outcome} = await run([
			[EPIC_READ, errOut("gh: Not Found (HTTP 404)")],
			...CLEAN.slice(1),
		]);
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("refuses an unreadable epic on 11 — absence is decided by status, never by text", async () => {
		const {outcome} = await run([
			[EPIC_READ, errOut("gh: Bad Gateway (HTTP 502)")],
			...CLEAN.slice(1),
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses an unreadable tree root on 11 — the run directory is UNKNOWN", async () => {
		const {outcome} = await run([
			[EPIC_READ, epic()],
			[TREE, errOut("fatal: not a git repository")],
			...CLEAN.slice(2),
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses when this lane does not hold the claim", async () => {
		const {outcome} = await run([
			[EPIC_READ, epic()],
			[TREE, GIT_DIRS],
			[
				/^gh api --paginate repos\/o\/r\/issues\/4300\/comments/,
				comments({id: 1, body: "nothing here"}),
			],
			...CLEAN.slice(4),
		]);
		expect(outcome.code).toBe(CLAIM_NOT_MINE);
		expect(outcome.stderr.at(-1)).toBe("ledger open: this lane does not hold #4300's claim.");
	});

	/** An unreachable index is `indeterminate`; only a read that ran and matched nothing is `none`. */
	it("seats an unreadable backlog on 11 rather than a clean none", async () => {
		const {outcome} = await run([
			...CLEAN.filter(([pattern]) => pattern !== BACKLOG),
			[BACKLOG, GATEWAY],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
	});

	it("ranks the open backlog and excludes the epic from its own candidates", async () => {
		const {outcome} = await run([
			...CLEAN.filter(([pattern]) => pattern !== BACKLOG),
			[BACKLOG, backlogPage([4300, "The moderation queue epic"], [4180, "moderation queue view"])],
		]);
		const {candidates} = JSON.parse(outcome.stdout);
		expect(candidates.outcome).toBe("candidates");
		expect(candidates.items.map((item: {number: number}) => item.number)).toEqual([4180]);
	});
});
