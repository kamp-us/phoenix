/**
 * `fabrika setup` over the real steps: the order it walks them in, where it stops, and what it tells
 * the person to do next. The filesystem and GitHub are scripted; the steps themselves are not.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeHttpBy, fakeShell, type HttpReply} from "../fakes.test-support.ts";
import {ok} from "../io/git.ts";
import {runBootstrap} from "../status/bootstrap-verb.ts";
import {PRECONDITION_UNKNOWN} from "../status/codes.ts";
import {runHomes} from "../triage/homes-verb.ts";
import {ANSWER} from "../verb.ts";
import {runSetup} from "./setup-verb.ts";

interface Milestone {
	readonly number: number;
	readonly title: string;
	readonly state: "open";
}

interface World {
	readonly files?: Readonly<Record<string, string>>;
	readonly labels?: ReadonlyArray<string>;
	readonly milestones?: ReadonlyArray<Milestone>;
	/** GitHub fails every label read, so the first label step refuses. */
	readonly labelsUnreadable?: boolean;
}

/** One repo's labels and milestones, answered the way GitHub's REST paths do. */
const github = (world: World) => {
	const labels = [...(world.labels ?? [])];
	const milestones = [...(world.milestones ?? [])];
	const json = (status: number, value: unknown): HttpReply => ({
		status,
		body: JSON.stringify(value),
	});
	const http = fakeHttpBy((line, body) => {
		if (line.endsWith("/user")) return json(200, {login: "octo"});
		if (line.includes("/milestones")) {
			if (line.startsWith("POST")) {
				const opened = {number: 4, title: JSON.parse(body).title, state: "open"} as const;
				milestones.push(opened);
				return json(201, opened);
			}
			const one = /\/milestones\/(\d+)$/.exec(line)?.[1];
			if (one === undefined) return json(200, milestones);
			const found = milestones.find((milestone) => milestone.number === Number(one));
			return found === undefined ? json(404, {message: "Not Found"}) : json(200, found);
		}
		if (world.labelsUnreadable === true) return json(500, {message: "down"});
		if (line.startsWith("POST")) {
			labels.push(JSON.parse(body).name);
			return json(201, {});
		}
		return json(
			200,
			labels.map((name) => ({name})),
		);
	});
	return {http, labels, milestones};
};

const setup = async (world: World, handCheck = false) => {
	const fs = fakeFs({files: {...world.files}});
	const {http, labels, milestones} = github(world);
	const shell = fakeShell([]);
	const outcome = await Effect.runPromise(
		Effect.provide(
			runSetup({
				handCheck,
				runStep: (surfaceId, content) =>
					runBootstrap({
						surfaceId,
						path: null,
						json: false,
						repoRoot: "/repo",
						configSource: {_tag: "Absent"},
						repo: ok("o/r"),
						stdin: Effect.succeed(content),
					}),
			}),
			Layer.mergeAll(fs.layer, shell.layer, http.layer),
		),
	);
	const rows = outcome.stdout
		.split("\n")
		.filter((line) => line.startsWith("bootstrap\t"))
		.map((line) => line.split("\t").slice(1, 4).join(" "));
	const posts = () => http.calls.filter((call) => call.startsWith("POST"));
	return {outcome, rows, labels, milestones, written: fs.written, posts, shell};
};

const LABEL_ROWS = (outcome: "created" | "exists") => [
	expect.stringMatching(new RegExp(`^${outcome} label-taxonomy `)),
	expect.stringMatching(new RegExp(`^${outcome} issue-shape-markers `)),
];

const STARTER_ROADMAP = [
	"## Arcs",
	"",
	"| Arc | Milestone | State |",
	"|---|---|---|",
	"| First arc | #4 | active |",
	"",
].join("\n");

describe("fabrika setup", () => {
	it("runs the seven steps in order on a fresh repo, then says what to paste", async () => {
		const {outcome, rows, written, milestones, shell} = await setup({});
		expect(outcome.code).toBe(ANSWER);
		expect(rows).toEqual([
			"created settings-patch .claude/settings.json",
			...LABEL_ROWS("created"),
			"created gitignore-row .gitignore",
			"created first-milestone milestone #4",
			"created roadmap-focus ROADMAP.md",
			"created owners-file .github/CODEOWNERS",
		]);
		expect(milestones).toEqual([{number: 4, title: "First arc", state: "open"}]);
		expect(written.get("/repo/ROADMAP.md")).toBe(STARTER_ROADMAP);
		expect([...written.keys()].sort()).toEqual([
			"/repo/.claude/settings.json",
			"/repo/.github/CODEOWNERS",
			"/repo/.gitignore",
			"/repo/ROADMAP.md",
		]);
		expect(outcome.stdout.split("\n").slice(-6)).toEqual([
			"Setup finished: 7 steps made changes and 0 were already done. Nothing is committed or pushed yet.",
			"What to do next: paste these lines to commit and push the setup files:",
			"  git add .claude/settings.json .gitignore ROADMAP.md .github/CODEOWNERS",
			'  git commit -m "chore: set up fabrika"',
			"  git push -u origin HEAD",
			"",
		]);
		// The command prints the commit and push lines; it runs neither, and spawns nothing at all.
		expect(shell.calls).toEqual([]);
	});

	it("leaves a repo `triage homes` answers with the one milestone the roadmap names", async () => {
		const first = await setup({});
		const homes = await Effect.runPromise(
			Effect.provide(
				runHomes({
					roadmap: "/repo/ROADMAP.md",
					standingLanes: [],
					repo: "o/r",
					json: false,
					env: {},
				}),
				Layer.mergeAll(
					fakeFs({files: Object.fromEntries(first.written)}).layer,
					fakeShell([]).layer,
					github({milestones: first.milestones}).http.layer,
				),
			),
		);
		expect(homes.code).toBe(ANSWER);
		expect(homes.stdout.split("\n").filter((line) => line.startsWith("milestone\t"))).toEqual([
			"milestone\t4\tFirst arc",
		]);
	});

	it("answers exists on every row of a second run and changes no file, label or milestone", async () => {
		const first = await setup({});
		const second = await setup({
			files: Object.fromEntries(first.written),
			labels: first.labels,
			milestones: first.milestones,
		});
		expect(second.outcome.code).toBe(ANSWER);
		expect(second.rows).toEqual([
			"exists settings-patch .claude/settings.json",
			...LABEL_ROWS("exists"),
			"exists gitignore-row .gitignore",
			"exists first-milestone milestone #4",
			"exists roadmap-focus ROADMAP.md",
			"exists owners-file .github/CODEOWNERS",
		]);
		expect(second.written.size).toBe(0);
		expect(second.posts()).toEqual([]);
		expect(second.outcome.stdout).toContain(
			"Setup finished: all 7 steps were already done, so this run changed nothing.",
		);
		expect(second.outcome.stdout).toContain(
			"  git add .claude/settings.json .gitignore ROADMAP.md .github/CODEOWNERS",
		);
	});

	it("keeps a roadmap and a milestone the repo already has, and opens no second milestone", async () => {
		const {outcome, rows, written, posts} = await setup({
			files: {"/repo/ROADMAP.md": "# Ours\n"},
			milestones: [
				{number: 9, title: "Later", state: "open"},
				{number: 2, title: "Launch", state: "open"},
			],
		});
		expect(outcome.code).toBe(ANSWER);
		expect(rows.slice(-3, -1)).toEqual([
			"exists first-milestone milestone #2",
			"exists roadmap-focus ROADMAP.md",
		]);
		expect(written.has("/repo/ROADMAP.md")).toBe(false);
		expect(posts().filter((call) => call.includes("/milestones"))).toEqual([]);
	});

	it("pins the roadmap to a milestone the repo already had open", async () => {
		const {rows, written} = await setup({
			milestones: [{number: 2, title: "Launch", state: "open"}],
		});
		expect(rows.slice(-3, -1)).toEqual([
			"exists first-milestone milestone #2",
			"created roadmap-focus ROADMAP.md",
		]);
		expect(written.get("/repo/ROADMAP.md")).toContain("| First arc | #2 | active |");
	});

	it("stops at the step that refuses, on its code, after the finished steps' rows", async () => {
		const {outcome, written} = await setup({labelsUnreadable: true});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("bootstrap\tcreated\tsettings-patch\t.claude/settings.json\tok\n");
		expect(outcome.stderr.at(-1)).toContain("status bootstrap: cannot probe o/r labels");
		// `gitignore-row` sits after the refusing step and was never run.
		expect([...written.keys()]).toEqual(["/repo/.claude/settings.json"]);
	});

	it("writes the hand-check rule only under --hand-check", async () => {
		const without = await setup({});
		expect(without.written.has("/repo/.fabrika.jsonc")).toBe(false);

		const withFlag = await setup({}, true);
		expect(withFlag.rows.at(-1)).toBe("created hand-check-rule .fabrika.jsonc");
		expect(withFlag.rows).toHaveLength(8);
		expect(withFlag.written.has("/repo/.fabrika.jsonc")).toBe(true);
		expect(withFlag.outcome.stdout).toContain(
			"  git add .claude/settings.json .gitignore ROADMAP.md .github/CODEOWNERS .fabrika.jsonc",
		);
	});
});
