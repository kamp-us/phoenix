/**
 * `fabrika setup` over the real steps: the order it walks them in, where it stops, and what it tells
 * the person to do next. The filesystem and GitHub are scripted; the steps themselves are not.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeHttpBy, fakeShell, type HttpReply} from "../fakes.test-support.ts";
import {ok} from "../io/git.ts";
import {runBootstrap} from "../status/bootstrap-verb.ts";
import {NO_SCREENS, OFF_VOCABULARY, PRECONDITION_UNKNOWN} from "../status/codes.ts";
import {ANSWER} from "../verb.ts";
import {type HandCheck, handCheckOf, runSetup} from "./setup-verb.ts";

interface World {
	readonly files?: Readonly<Record<string, string>>;
	readonly labels?: ReadonlyArray<string>;
	/** GitHub fails every label read, so the first label step refuses. */
	readonly labelsUnreadable?: boolean;
}

/** One repo's labels, answered the way GitHub's REST paths do. Any milestone request is a 404. */
const github = (world: World) => {
	const labels = [...(world.labels ?? [])];
	const json = (status: number, value: unknown): HttpReply => ({
		status,
		body: JSON.stringify(value),
	});
	const http = fakeHttpBy((line, body) => {
		if (line.endsWith("/user")) return json(200, {login: "octo"});
		if (line.includes("/milestones")) return json(404, {message: "Not Found"});
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
	return {http, labels};
};

const WORKFLOWS = "/repo/.github/workflows";

const OFF: HandCheck = {_tag: "Off"};

const setup = async (world: World, handCheck: HandCheck = OFF) => {
	// The fake lists a directory only when told what it holds, so a seeded workflow file is listed here.
	const workflows = Object.keys(world.files ?? {}).flatMap((file) =>
		file.startsWith(`${WORKFLOWS}/`) ? [file.slice(WORKFLOWS.length + 1)] : [],
	);
	const fs = fakeFs({
		files: {...world.files},
		dirs: workflows.length === 0 ? {} : {[WORKFLOWS]: workflows},
	});
	const {http, labels} = github(world);
	const shell = fakeShell([]);
	const outcome = await Effect.runPromise(
		Effect.provide(
			runSetup({
				handCheck,
				runStep: (surfaceId, screens) =>
					runBootstrap({
						surfaceId,
						path: null,
						screens,
						json: false,
						repoRoot: "/repo",
						configSource: {_tag: "Absent"},
						repo: ok("o/r"),
						stdin: Effect.succeed({_tag: "NoStdin", reason: "test"}),
					}),
			}),
			Layer.mergeAll(fs.layer, shell.layer, http.layer),
		),
	);
	const rows = outcome.stdout
		.split("\n")
		.filter((line) => line.startsWith("bootstrap\t"))
		.map((line) => line.split("\t").slice(1, 4).join(" "));
	const milestoneCalls = () => http.calls.filter((call) => call.includes("/milestones"));
	const posts = () => http.calls.filter((call) => call.startsWith("POST"));
	return {outcome, rows, labels, written: fs.written, posts, milestoneCalls, shell};
};

const SIX_ROWS = (outcome: "created" | "exists") => [
	`${outcome} settings-patch .claude/settings.json`,
	expect.stringMatching(new RegExp(`^${outcome} label-taxonomy `)),
	expect.stringMatching(new RegExp(`^${outcome} issue-shape-markers `)),
	`${outcome} gitignore-row .gitignore`,
	`${outcome} owners-file .github/CODEOWNERS`,
	`${outcome} ci-file .github/workflows/ci.yml`,
];

const ADD_LINE =
	"  git add .claude/settings.json .gitignore .github/CODEOWNERS .github/workflows/ci.yml";

const HOME_LINES = [
	"Then give work a home: open one milestone and write a roadmap that names it, by hand, as step 7",
	'of the getting-started guide, "Give the board a home to put work in", shows.',
];

describe("fabrika setup", () => {
	it("runs the six steps in order on a fresh repo, then says what to paste and where work goes", async () => {
		const {outcome, rows, written, milestoneCalls, shell} = await setup({});
		expect(outcome.code).toBe(ANSWER);
		expect(rows).toEqual(SIX_ROWS("created"));
		expect([...written.keys()].sort()).toEqual([
			"/repo/.claude/settings.json",
			"/repo/.github/CODEOWNERS",
			"/repo/.github/workflows/ci.yml",
			"/repo/.gitignore",
		]);
		// No step opens a milestone, or so much as reads one.
		expect(milestoneCalls()).toEqual([]);
		expect(outcome.stdout.split("\n").slice(-8)).toEqual([
			"Setup finished: 6 steps made changes and 0 were already done. Nothing is committed or pushed yet.",
			"What to do next: paste these lines to commit and push the setup files:",
			ADD_LINE,
			'  git commit -m "chore: set up fabrika"',
			"  git push -u origin HEAD",
			...HOME_LINES,
			"",
		]);
		expect(outcome.stdout).not.toContain("triage homes");
		// The command prints the commit and push lines; it runs neither, and spawns nothing at all.
		expect(shell.calls).toEqual([]);
	});

	it("answers exists on every row of a second run and changes no file or label", async () => {
		const first = await setup({});
		const second = await setup({files: Object.fromEntries(first.written), labels: first.labels});
		expect(second.outcome.code).toBe(ANSWER);
		expect(second.rows).toEqual(SIX_ROWS("exists"));
		expect(second.written.size).toBe(0);
		expect(second.posts()).toEqual([]);
		expect(second.outcome.stdout).toContain(
			"Setup finished: all 6 steps were already done, so this run changed nothing.",
		);
		expect(second.outcome.stdout).toContain(ADD_LINE);
	});

	it("leaves a roadmap the repo already has untouched and prints no row for it", async () => {
		const {outcome, rows, written, milestoneCalls} = await setup({
			files: {"/repo/ROADMAP.md": "# Ours\n"},
		});
		expect(outcome.code).toBe(ANSWER);
		expect(rows).toEqual(SIX_ROWS("created"));
		expect(written.has("/repo/ROADMAP.md")).toBe(false);
		expect(outcome.stdout).not.toContain("ROADMAP.md");
		expect(milestoneCalls()).toEqual([]);
	});

	it("stops at the step that refuses, on its code, after the finished steps' rows", async () => {
		const {outcome, written} = await setup({labelsUnreadable: true});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("bootstrap\tcreated\tsettings-patch\t.claude/settings.json\tok\n");
		expect(outcome.stderr.at(-1)).toContain("status bootstrap: cannot probe o/r labels");
		// `gitignore-row` sits after the refusing step and was never run.
		expect([...written.keys()]).toEqual(["/repo/.claude/settings.json"]);
	});

	it("writes the hand-check rule only under --hand-check, with the screens it was given", async () => {
		const without = await setup({});
		expect(without.written.has("/repo/.fabrika.jsonc")).toBe(false);

		const withFlag = await setup({}, {_tag: "On", screens: ["index.html"]});
		expect(withFlag.outcome.code).toBe(ANSWER);
		expect(withFlag.rows).toEqual([
			...SIX_ROWS("created"),
			"created hand-check-rule .fabrika.jsonc",
		]);
		const config = JSON.parse(withFlag.written.get("/repo/.fabrika.jsonc") ?? "{}");
		expect(config.reviewUi).toEqual({mode: "hand-check", screens: ["index.html"]});
		expect(withFlag.outcome.stdout).toContain(`${ADD_LINE} .fabrika.jsonc`);
	});

	it("stops on the hand-check step's own code when --hand-check names no screen in a repo with none", async () => {
		const {outcome, rows, written} = await setup({}, {_tag: "On", screens: []});
		expect(outcome.code).toBe(NO_SCREENS);
		expect(rows).toEqual(SIX_ROWS("created"));
		expect(written.has("/repo/.fabrika.jsonc")).toBe(false);
		expect(outcome.stderr.at(-1)).toContain("--screens <path>");
	});
});

describe("handCheckOf", () => {
	it("carries the screens only when the hand-check step runs", () => {
		expect(handCheckOf(false, [])).toEqual({_tag: "Off"});
		expect(handCheckOf(true, [])).toEqual({_tag: "On", screens: []});
		expect(handCheckOf(true, ["src/app/"])).toEqual({_tag: "On", screens: ["src/app/"]});
	});

	it("refuses --screens without --hand-check on 10, before any step", () => {
		const refused = handCheckOf(false, ["index.html"]);
		expect(refused._tag).toBe("Refused");
		if (refused._tag !== "Refused") return;
		expect(refused.outcome.code).toBe(OFF_VOCABULARY);
		expect(refused.outcome.stdout).toBe("");
		expect(refused.outcome.stderr.at(-1)).toContain(
			"--screens is read only by the hand-check-rule step",
		);
	});
});
