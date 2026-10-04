/**
 * `fabrika setup` over the real steps: the order it walks them in, where it stops, and what it tells
 * the person to do next. The filesystem and GitHub are scripted; the steps themselves are not.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeHttpBy, fakeShell} from "../fakes.test-support.ts";
import {ok} from "../io/git.ts";
import type {StdinRead} from "../io/stdin.ts";
import {runBootstrap} from "../status/bootstrap-verb.ts";
import {PRECONDITION_UNKNOWN} from "../status/codes.ts";
import {ANSWER} from "../verb.ts";
import {runSetup} from "./setup-verb.ts";

interface World {
	readonly files?: Readonly<Record<string, string>>;
	readonly labels?: ReadonlyArray<string>;
	/** GitHub fails every label read, so the first label step refuses. */
	readonly labelsUnreadable?: boolean;
}

const setup = async (world: World, handCheck = false) => {
	const fs = fakeFs({files: {...world.files}});
	const labels = [...(world.labels ?? [])];
	const http = fakeHttpBy((line, body) => {
		if (world.labelsUnreadable === true) return {status: 500, body: '{"message":"down"}'};
		if (line.startsWith("POST")) {
			labels.push(JSON.parse(body).name);
			return {status: 201, body: "{}"};
		}
		return {status: 200, body: JSON.stringify(labels.map((name) => ({name})))};
	});
	const shell = fakeShell([]);
	const outcome = await Effect.runPromise(
		Effect.provide(
			runSetup({
				handCheck,
				runStep: (surfaceId) =>
					runBootstrap({
						surfaceId,
						path: null,
						json: false,
						repoRoot: "/repo",
						configSource: {_tag: "Absent"},
						repo: ok("o/r"),
						stdin: Effect.succeed({_tag: "NoStdin"} as StdinRead),
					}),
			}),
			Layer.mergeAll(fs.layer, shell.layer, http.layer),
		),
	);
	const rows = outcome.stdout
		.split("\n")
		.filter((line) => line.startsWith("bootstrap\t"))
		.map((line) => line.split("\t").slice(1, 3).join(" "));
	return {outcome, rows, labels, written: fs.written, http, shell};
};

describe("fabrika setup", () => {
	it("runs the four steps in order on a fresh repo, then says what to paste", async () => {
		const {outcome, rows, written, shell} = await setup({});
		expect(outcome.code).toBe(ANSWER);
		expect(rows).toEqual([
			"created settings-patch",
			"created label-taxonomy",
			"created issue-shape-markers",
			"created gitignore-row",
		]);
		expect([...written.keys()].sort()).toEqual(["/repo/.claude/settings.json", "/repo/.gitignore"]);
		expect(outcome.stdout.split("\n").slice(-6)).toEqual([
			"Setup finished: 4 steps made changes and 0 were already done. Nothing is committed or pushed yet.",
			"What to do next: paste these lines to commit and push the setup files:",
			"  git add .claude/settings.json .gitignore",
			'  git commit -m "chore: set up fabrika"',
			"  git push -u origin HEAD",
			"",
		]);
		// The command prints the commit and push lines; it runs neither, and spawns nothing at all.
		expect(shell.calls).toEqual([]);
	});

	it("answers exists on every row of a second run and changes no file and no label", async () => {
		const first = await setup({});
		const second = await setup({
			files: Object.fromEntries(first.written),
			labels: first.labels,
		});
		expect(second.outcome.code).toBe(ANSWER);
		expect(second.rows).toEqual([
			"exists settings-patch",
			"exists label-taxonomy",
			"exists issue-shape-markers",
			"exists gitignore-row",
		]);
		expect(second.written.size).toBe(0);
		expect(second.http.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
		expect(second.outcome.stdout).toContain(
			"Setup finished: all 4 steps were already done, so this run changed nothing.",
		);
		expect(second.outcome.stdout).toContain("  git add .claude/settings.json .gitignore");
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
		expect(withFlag.rows.at(-1)).toBe("created hand-check-rule");
		expect(withFlag.rows).toHaveLength(5);
		expect(withFlag.written.has("/repo/.fabrika.jsonc")).toBe(true);
		expect(withFlag.outcome.stdout).toContain(
			"  git add .claude/settings.json .gitignore .fabrika.jsonc",
		);
	});
});
