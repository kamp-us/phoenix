/**
 * `lane cleanup` against real git — what a scripted spawner cannot show.
 *
 * The unit tier pins which commands run. Here git decides: whether a plain `worktree remove` takes
 * a tree that holds ignored installs, whether `rev-list --not --remotes` tells a pushed commit from
 * a local one, and whether a recorded path still matches git's list when the temp directory sits
 * behind a symlinked prefix.
 */
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {afterEach, describe, expect, it} from "vitest";
import {ok} from "../io/git.ts";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {runCleanup} from "./cleanup-verb.ts";
import {TREES_KEPT} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";

const LANE = "42";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
	execFileSync("git", args, {cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim();

const runnerCwd = process.cwd();
afterEach(() => process.chdir(runnerCwd));

describe("lane cleanup over a real clone", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("removes the clean and the pushed tree, keeps the dirty and the local-only one, and leaves its own", async () => {
		const home = mkdtempSync(join(tmpdir(), "lane-cleanup-"));
		const origin = join(home, "origin.git");
		const root = join(home, "checkout");
		execFileSync("git", ["init", "--bare", "--initial-branch=main", origin]);
		execFileSync("git", ["clone", origin, root], {stdio: "ignore"});
		git(root, "config", "user.email", "cleanup@example.test");
		git(root, "config", "user.name", "cleanup");
		writeFileSync(join(root, ".gitignore"), ".fabrika/\nnode_modules/\n");
		git(root, "add", "-A");
		git(root, "commit", "-m", "base");
		git(root, "push", "-u", "origin", "HEAD:main");

		const tree = (name: string) => join(root, ".claude", "worktrees", name);
		for (const name of ["clean", "dirty", "local", "pushed", "driver"]) {
			git(root, "worktree", "add", "--detach", tree(name), "origin/main");
		}
		mkdirSync(join(tree("clean"), "node_modules"));
		writeFileSync(join(tree("clean"), "node_modules", "installed.js"), "ignored\n");
		writeFileSync(join(tree("dirty"), "notes.md"), "not committed\n");
		const commit = (name: string) => {
			writeFileSync(join(tree(name), `${name}.txt`), `${name}\n`);
			git(tree(name), "add", "-A");
			git(tree(name), "commit", "-m", `work in ${name}`);
		};
		commit("local");
		git(tree("pushed"), "switch", "-c", "build/42-pushed");
		commit("pushed");
		git(tree("pushed"), "push", "-u", "origin", "build/42-pushed");

		const dir = join(root, ".fabrika", "lanes", LANE);
		mkdirSync(dir, {recursive: true});
		writeFileSync(join(dir, "workflow.json"), coderTemplateText());
		writeFileSync(
			join(dir, "worktrees.jsonl"),
			["clean", "dirty", "local", "pushed", "driver"]
				.map((name) =>
					JSON.stringify({kind: "handed", worktree: tree(name), task: "issue", at: "2026-10-03"}),
				)
				.join("\n")
				.concat("\n"),
		);

		process.chdir(tree("driver"));
		const outcome = await Effect.runPromise(
			Effect.provide(
				runCleanup({
					root: join(root, ".fabrika", "lanes"),
					lane: LANE,
					caller: ok(tree("driver")),
					pull: () => Effect.succeed({_tag: "Unmerged"} as const),
				}),
				NodeServices.layer,
			),
		);

		expect(outcome.code).toBe(TREES_KEPT);
		expect(outcome.stderr).toEqual([
			`fabrika lane cleanup: kept ${tree("dirty")} — uncommitted: 1 uncommitted path`,
			`fabrika lane cleanup: kept ${tree("local")} — unpublished: 1 commit on no remote ref — the lane's log names no pull request`,
			`fabrika lane cleanup: left ${tree("driver")} — this verb runs in it; it is the caller's to remove from outside`,
			`fabrika lane cleanup: removed ${tree("clean")}`,
			`fabrika lane cleanup: removed ${tree("pushed")}`,
			expect.stringContaining("2 of 5 recorded worktree(s) kept"),
		]);
		expect(
			["clean", "dirty", "local", "pushed", "driver"].filter((name) => existsSync(tree(name))),
		).toEqual(["dirty", "local", "driver"]);
		// The removal takes the checkout and leaves the branch.
		expect(git(root, "branch", "--list", "build/42-pushed")).toContain("build/42-pushed");
		expect(
			readFileSync(join(dir, "worktrees.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.filter((record) => record.kind === "removed")
				.map((record) => record.worktree),
		).toEqual([tree("clean"), tree("pushed")]);
	});
});
