/**
 * The branch-claim read driven against **real git**, over the shape that collided.
 *
 * The claim under test is a claim about what git's ref store shows one lane about another's
 * unpublished work, so it is run rather than reasoned about (CLAUDE.md: ground platform claims in
 * source or in a real run). Scripted seams cannot prove it: they would assert the argv this module
 * types, which is the thing that was wrong.
 *
 * `execCapture` spawns in the process's own working directory, so the fixture is entered with
 * `process.chdir` and the runner's directory is put back in `afterEach` — the one way to drive the
 * shipped reader rather than a re-typed copy of its argv.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/8901
 */
import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {afterEach, describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {loadBranchClaims} from "./branch-claims.ts";
import {allocate} from "./next.ts";

/** Pinned away from the developer's own config: a fixture that inherits it proves what this machine does. */
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

const DIR = ".decisions";

interface Repo {
	readonly dir: string;
	readonly git: (...args: ReadonlyArray<string>) => string;
	readonly record: (name: string) => void;
	readonly commit: (message: string) => void;
	readonly rev: (ref: string) => string;
}

/** A repo whose `main` already carries `0372` — the assembly tip the two children were cut from. */
const seeded = (): Repo => {
	const dir = mkdtempSync(join(tmpdir(), "fabrika-branch-claims-"));
	const git = (...args: ReadonlyArray<string>): string =>
		execFileSync("git", [...args], {cwd: dir, env: GIT_ENV, encoding: "utf8"});
	git("init", "--quiet", "-b", "main");
	git("config", "core.hooksPath", join(dir, ".no-hooks"));
	mkdirSync(join(dir, DIR));
	const repo: Repo = {
		dir,
		git,
		rev: (ref) => git("rev-parse", ref).trim(),
		record: (name) => writeFileSync(join(dir, DIR, name), `---\nstatus: accepted\n---\n`),
		commit: (message) => {
			git("add", "-A");
			git("commit", "--quiet", "-m", message);
		},
	};
	repo.record("0372-the-assembly-tip.md");
	repo.commit("the record main carries");
	return repo;
};

/** A branch cut from `from`, carrying one record, with `from` left checked out. */
const child = (repo: Repo, from: string, branch: string, record: string): void => {
	repo.git("checkout", "--quiet", "-b", branch, from);
	repo.record(record);
	repo.commit(`the child's record (${branch})`);
	repo.git("checkout", "--quiet", from);
};

const read = (repo: Repo, baseSha: string) => {
	const before = process.cwd();
	process.chdir(repo.dir);
	return Effect.runPromise(
		Effect.provide(loadBranchClaims(baseSha, DIR), NodeServices.layer),
	).finally(() => process.chdir(before));
};

const runnerCwd = process.cwd();
afterEach(() => process.chdir(runnerCwd));

describe("loadBranchClaims against two sibling branches cut from one assembly tip", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("names the sibling's mint, so the second child is not handed the same id", async () => {
		const repo = seeded();
		repo.git("checkout", "--quiet", "-b", "epic/8810");
		const tip = repo.rev("epic/8810");
		// The first child mints 0373 on its own branch. No pull request anywhere: a child opens
		// none, and the assembly branch is not pushed until the tail.
		child(repo, "epic/8810", "build/8820", "0373-driver-seat-on-a-spent-repair-budget.md");
		// The second child is cut from the identical tip and asks for the next free id.
		repo.git("checkout", "--quiet", "-b", "build/8821", "epic/8810");

		const claims = await read(repo, tip);
		expect(claims).toEqual({
			_tag: "Ok",
			value: [{id: "0373", file: "0373-driver-seat-on-a-spent-repair-budget.md"}],
		});

		const merged = ["0372"];
		const branchIds = claims._tag === "Ok" ? claims.value.map((c) => c.id) : [];
		// The regression: the merged set and the in-flight set both read 0373 as free.
		expect(allocate(merged, [], []).id).toBe("0373");
		expect(allocate(merged, [], branchIds).id).toBe("0374");
	});

	it("claims nothing off a branch the base already carries", async () => {
		const repo = seeded();
		child(repo, "main", "build/8820", "0373-already-folded.md");
		repo.git("merge", "--quiet", "--ff-only", "build/8820");

		await expect(read(repo, repo.rev("main"))).resolves.toEqual({_tag: "Ok", value: []});
	});

	it("skips a name it cannot read an id from rather than refusing over it", async () => {
		const repo = seeded();
		const tip = repo.rev("main");
		repo.git("checkout", "--quiet", "-b", "build/8820");
		writeFileSync(join(repo.dir, DIR, "index.md"), "not a record\n");
		repo.commit("a branch carrying a non-record file under the corpus");
		repo.git("checkout", "--quiet", "main");

		await expect(read(repo, tip)).resolves.toEqual({_tag: "Ok", value: []});
	});

	it("is UNKNOWN when the walk cannot run, never an empty claim set", async () => {
		const repo = seeded();
		const outcome = await read(repo, "0000000000000000000000000000000000000000");
		expect(outcome._tag).toBe("Err");
	});
});
