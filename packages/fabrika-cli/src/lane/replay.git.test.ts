/**
 * The replay leg driven against **real git** in a throwaway repository.
 *
 * The claims under test are claims about what git does — that two children appending to one registry
 * conflict at the merge, that a cherry-pick under `merge.conflictStyle=diff3` writes a base section
 * a resolver can read, that the seat comes back on its branch — so they are run rather than reasoned
 * about (CLAUDE.md: ground platform claims in source or in a real run). The scripted-shell half is
 * `replay.unit.test.ts` beside this file, which drives the arms a real git will not produce on
 * demand.
 *
 * The fixture is the collision the epic run actually hit: two reviewed children each appending a row
 * to one flag registry, every hunk a plain keep-both, every one resolved by hand before this leg
 * existed.
 */

import {execFileSync} from "node:child_process";
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {replayBranchName, replayChild} from "./replay.ts";

const REGISTRY = "flags.ts";
const BRANCH = "epic";

const registry = (...rows: ReadonlyArray<string>): string =>
	["export const FLAGS = {", ...rows.map((row) => `\t${row}`), "} as const;", ""].join("\n");

interface Repo {
	readonly dir: string;
	readonly git: (...args: ReadonlyArray<string>) => string;
	readonly write: (path: string, body: string) => void;
	readonly read: (path: string) => string;
	readonly commit: (message: string) => string;
	readonly rev: (ref: string) => string;
}

/**
 * A repository whose identity, hooks and signing are pinned in its own local config.
 *
 * Local config, not the process environment: the leg under test spawns git itself and inherits this
 * process's environment, so a fixture that pinned `GIT_CONFIG_GLOBAL` would be pinning it for
 * whatever else shares the worker. What the leg does pass per-command — `merge.conflictStyle=diff3`
 * — overrides any of these anyway, which is the point of passing it there.
 */
const openRepo = (): Repo => {
	const dir = mkdtempSync(join(tmpdir(), "fabrika-replay-"));
	const git = (...args: ReadonlyArray<string>): string =>
		execFileSync("git", [...args], {cwd: dir, encoding: "utf8"});
	git("init", "--quiet", "-b", BRANCH);
	const settings: ReadonlyArray<readonly [string, string]> = [
		["user.name", "fixture"],
		["user.email", "fixture@example.invalid"],
		["commit.gpgsign", "false"],
		["core.hooksPath", join(dir, ".no-hooks")],
	];
	for (const [key, value] of settings) git("config", key, value);
	const rev = (ref: string): string => git("rev-parse", ref).trim();
	return {
		dir,
		git,
		rev,
		write: (path, body) => writeFileSync(join(dir, path), body),
		read: (path) => readFileSync(join(dir, path), "utf8"),
		commit: (message) => {
			git("add", "-A");
			git("commit", "--quiet", "-m", message);
			return rev("HEAD");
		},
	};
};

/**
 * The two-children-one-registry collision: the tip carries the first child's row, and the second
 * child's branch adds its own at the same place off the common base.
 */
const collided = (theirs: string): Repo => {
	const repo = openRepo();
	repo.write(REGISTRY, registry('existing: "on",'));
	repo.commit("base");
	repo.git("branch", "child");

	repo.write(REGISTRY, registry('existing: "on",', 'assemblyRefresh: "off",'));
	repo.commit("the first child's row");

	repo.git("checkout", "--quiet", "child");
	repo.write(REGISTRY, theirs);
	repo.commit("the second child's row");
	repo.git("checkout", "--quiet", BRANCH);
	return repo;
};

const replay = (repo: Repo, tip: string) =>
	Effect.runPromise(
		Effect.provide(
			replayChild({path: repo.dir, branch: BRANCH, child: "child", tip}),
			NodeServices.layer,
		),
	);

describe("replayChild against real git", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("replays a plain keep-both collision onto the tip and merges it", async () => {
		const repo = collided(registry('existing: "on",', 'laneConcurrencyCap: "4",'));
		const tip = repo.rev(BRANCH);
		// The premise: without the replay this is exactly the merge `lane integrate` aborts.
		expect(() => repo.git("merge", "--no-ff", "--no-edit", "child")).toThrow();
		repo.git("merge", "--abort");

		const outcome = await replay(repo, tip);

		expect(outcome._tag).toBe("Replayed");
		if (outcome._tag !== "Replayed") return;
		expect(outcome.resolved).toEqual([REGISTRY]);
		expect(outcome.commits).toBe(1);
		expect(outcome.replayBranch).toBe(replayBranchName("child", tip));

		// The range moved: it is the child's work on a head its reviewer never saw.
		expect(outcome.range.from).toBe(tip);
		expect(outcome.range.to).not.toBe(repo.rev("child"));
		expect(repo.rev(outcome.replayBranch)).toBe(outcome.range.to);

		// Both rows survived, and the seat is back on its branch carrying the merge.
		expect(repo.read(REGISTRY)).toBe(
			registry('existing: "on",', 'assemblyRefresh: "off",', 'laneConcurrencyCap: "4",'),
		);
		expect(repo.git("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(BRANCH);
		expect(repo.rev(`${BRANCH}^1`)).toBe(tip);
		expect(repo.rev(`${BRANCH}^2`)).toBe(outcome.range.to);
	});

	it("replays every commit of a child that landed more than one", async () => {
		const repo = collided(registry('existing: "on",', 'laneConcurrencyCap: "4",'));
		repo.git("checkout", "--quiet", "child");
		repo.write("README.md", "a second commit touching nothing the tip touched\n");
		repo.commit("the second child's other commit");
		repo.git("checkout", "--quiet", BRANCH);
		const tip = repo.rev(BRANCH);

		const outcome = await replay(repo, tip);

		expect(outcome._tag).toBe("Replayed");
		if (outcome._tag !== "Replayed") return;
		expect(outcome.commits).toBe(2);
		expect(repo.read("README.md")).toContain("a second commit");
	});

	it("names a path kept both ways once, however many of the child's commits conflicted on it", async () => {
		const repo = collided(registry('existing: "on",', 'laneConcurrencyCap: "4",'));
		repo.git("checkout", "--quiet", "child");
		repo.write(
			REGISTRY,
			registry('existing: "on",', 'auditCatalogs: "on",', 'laneConcurrencyCap: "4",'),
		);
		repo.commit("the second child's other row, in the same registry");
		repo.git("checkout", "--quiet", BRANCH);
		const tip = repo.rev(BRANCH);

		const outcome = await replay(repo, tip);

		expect(outcome._tag).toBe("Replayed");
		if (outcome._tag !== "Replayed") return;
		expect(outcome.commits).toBe(2);
		expect(outcome.resolved).toEqual([REGISTRY]);
	});

	it("leaves the branch where it found it when a hunk is not a plain keep-both", async () => {
		// The child rewrites the row the tip already carries, which is two sides editing one text.
		const repo = collided(registry('existing: "off",'));
		const tip = repo.rev(BRANCH);

		const outcome = await replay(repo, tip);

		expect(outcome._tag).toBe("NotKeepBoth");
		if (outcome._tag !== "NotKeepBoth") return;
		expect(outcome.paths).toEqual([REGISTRY]);
		expect(outcome.reason).toContain(REGISTRY);

		expect(repo.git("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(BRANCH);
		expect(repo.rev(BRANCH)).toBe(tip);
		expect(repo.git("status", "--porcelain").trim()).toBe("");
	});

	it("is UNKNOWN when the child adds no commit the tip does not already carry", async () => {
		const repo = collided(registry('existing: "on",', 'laneConcurrencyCap: "4",'));
		repo.git("branch", "--force", "child", BRANCH);

		const outcome = await replay(repo, repo.rev(BRANCH));

		expect(outcome._tag).toBe("Unreadable");
	});
});
