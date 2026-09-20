/**
 * The containment read driven against **real git**, over a **real squash landing**.
 *
 * The claim under test is a claim about what git does — that a squash-merged branch's head is not an
 * ancestor of the trunk, and that its cumulative patch id nevertheless equals the trunk commit's —
 * so it is run rather than reasoned about (CLAUDE.md: ground platform claims in source or in a real
 * run). A merge-commit fixture proves nothing here: `merge-base --is-ancestor` already answers those,
 * and it is exactly the squash shape it cannot answer.
 *
 * `execCapture` spawns in the process's own working directory, so the fixture is entered with
 * `process.chdir` and the runner's directory is put back in `afterEach`. That is the one way to
 * drive the shipped Effect reader itself rather than a re-typed copy of its argv.
 */
import {execFileSync} from "node:child_process";
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {afterEach, describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {containmentOf} from "./containment.ts";

/**
 * Both config layers are pinned away from the developer's own: merge behaviour is configurable, and
 * a fixture that inherits it proves what this machine does rather than what git does.
 */
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
	GIT_AUTHOR_DATE: "2026-09-10T00:00:00Z",
	GIT_COMMITTER_DATE: "2026-09-10T00:00:00Z",
};

interface Repo {
	readonly dir: string;
	readonly git: (...args: ReadonlyArray<string>) => string;
	readonly write: (path: string, body: string) => void;
	readonly commit: (message: string) => string;
	readonly rev: (ref: string) => string;
}

const openRepo = (): Repo => {
	const dir = mkdtempSync(join(tmpdir(), "fabrika-containment-"));
	const git = (...args: ReadonlyArray<string>): string =>
		execFileSync("git", [...args], {cwd: dir, env: GIT_ENV, encoding: "utf8"});
	git("init", "--quiet", "-b", "main");
	git("config", "core.hooksPath", join(dir, ".no-hooks"));
	return {
		dir,
		git,
		rev: (ref) => git("rev-parse", ref).trim(),
		write: (path, body) => writeFileSync(join(dir, path), body),
		commit: (message) => {
			git("add", "-A");
			git("commit", "--quiet", "-m", message);
			return git("rev-parse", "HEAD").trim();
		},
	};
};

/** A branch off `main` carrying one change, with `main` left checked out. */
const branched = (repo: Repo, file: string, body: string): void => {
	repo.git("checkout", "--quiet", "-b", "feature");
	repo.write(file, body);
	repo.commit("the branch's work");
	repo.git("checkout", "--quiet", "main");
};

const seeded = (): Repo => {
	const repo = openRepo();
	repo.write("a.txt", "base\n");
	repo.commit("base");
	return repo;
};

const read = (repo: Repo, head: string, trunk: string) => {
	const before = process.cwd();
	process.chdir(repo.dir);
	return Effect.runPromise(Effect.provide(containmentOf(head, trunk), NodeServices.layer)).finally(
		() => process.chdir(before),
	);
};

const runnerCwd = process.cwd();
afterEach(() => process.chdir(runnerCwd));

describe("containmentOf against a real squash landing", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("reads a squash-landed branch as contained, where ancestry reads it as unlanded", async () => {
		const repo = seeded();
		branched(repo, "a.txt", "changed\n");
		repo.git("merge", "--squash", "feature");
		const squash = repo.commit("feat: the branch's work, squashed (#1)");

		// The premise this whole reader exists for: on a squash trunk, ancestry says "not contained".
		expect(() => repo.git("merge-base", "--is-ancestor", "feature", "main")).toThrow();

		await expect(read(repo, "feature", "main")).resolves.toEqual({
			_tag: "Squashed",
			commit: squash,
		});
	});

	it("reads a branch whose work never landed as unlanded, so nothing re-cuts it", async () => {
		const repo = seeded();
		branched(repo, "b.txt", "only here\n");
		repo.write("a.txt", "trunk moved\n");
		repo.commit("the trunk's own commit");

		await expect(read(repo, "feature", "main")).resolves.toEqual({_tag: "Unlanded"});
	});

	it("reads a fast-forwarded branch as an ancestor without paying for the patch reads", async () => {
		const repo = seeded();
		branched(repo, "a.txt", "changed\n");
		repo.git("merge", "--ff-only", "feature");

		await expect(read(repo, "feature", "main")).resolves.toEqual({_tag: "Ancestor"});
	});

	it("reads a branch that nets to nothing against the trunk as adding no content", async () => {
		const repo = seeded();
		repo.git("checkout", "--quiet", "-b", "feature");
		repo.write("a.txt", "changed\n");
		repo.commit("the branch's work");
		repo.write("a.txt", "base\n");
		repo.commit("and its revert");
		repo.git("checkout", "--quiet", "main");

		await expect(read(repo, "feature", "main")).resolves.toEqual({_tag: "NoChange"});
	});
});
