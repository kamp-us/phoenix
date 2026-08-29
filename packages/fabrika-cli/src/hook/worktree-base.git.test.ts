/**
 * `hook worktree-create`'s base resolution under **parallel spawns**, driven against real git in a
 * throwaway clone (#6081).
 *
 * The claim under test is not one about argv — it is one about what git does when several spawns
 * fetch the same clone at once, so it is run rather than reasoned about (CLAUDE.md: ground platform
 * claims in a real run). The old shape read `FETCH_HEAD`, which is one file in the shared `.git` dir:
 * a sibling's fetch truncates it mid-read and the loser's spawn dies on `fatal: invalid reference:
 * FETCH_HEAD`. Measured here on git 2.40.1 before the fix, 12 of 320 concurrent fetch-then-resolve
 * pairs came back empty; point {@link fetchBaseArgs} back at `FETCH_HEAD` and this file goes red.
 *
 * What is exercised is the derivation the verb performs — the argv from {@link fetchBaseArgs},
 * {@link resolveBaseArgs} and {@link dropBaseRefArgs}, and the guard in {@link isCommitId}. The
 * Effect wrapper around them folds the same pieces over a scripted spawner elsewhere; running it
 * here would mean standing up a spawner layer per concurrent spawn to prove a property that is
 * git's, not Effect's.
 *
 * `git worktree add` is deliberately **not** in the loop. It carries concurrency faults of its own
 * that this change does not claim to fix — a sibling's null-oid `worktrees/<name>/HEAD` placeholder
 * breaking a concurrent fetch's connectivity check, and `failed to read …/commondir` between two
 * adds — so including it would make this file red for reasons it is not judging.
 */
import {execFile, execFileSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import {afterAll, describe, expect, it} from "vitest";
import {
	baseRefFor,
	dropBaseRefArgs,
	fetchBaseArgs,
	isCommitId,
	resolveBaseArgs,
} from "./worktree-create.ts";

const run = promisify(execFile);

/** Pinned away from the developer's own config: a fixture that inherits it proves what this machine does. */
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

/**
 * Enough history that a fetch takes long enough for sibling fetches to genuinely overlap. With a
 * near-empty repo the fetches finish before each other start and the race never opens at all.
 */
const COMMITS = 40;
const SPAWNS = 16;
const ROUNDS = 20;

const roots: string[] = [];

interface Fixture {
	readonly clone: string;
	readonly tip: string;
}

const openClone = (): Fixture => {
	const root = mkdtempSync(join(tmpdir(), "fabrika-worktree-base-"));
	roots.push(root);
	const git = (cwd: string | undefined, ...args: ReadonlyArray<string>): string =>
		execFileSync("git", [...args], {cwd, env: GIT_ENV, encoding: "utf8"});

	const remote = join(root, "remote.git");
	const seed = join(root, "seed");
	const clone = join(root, "clone");
	git(undefined, "init", "--quiet", "--bare", "-b", "main", remote);
	git(undefined, "init", "--quiet", "-b", "main", seed);
	for (let i = 0; i < COMMITS; i++) {
		writeFileSync(join(seed, `f${i}.txt`), `${"x".repeat(20_000)}${i}`);
		git(seed, "add", "-A");
		git(seed, "commit", "--quiet", "-m", `c${i}`);
	}
	git(seed, "remote", "add", "origin", remote);
	git(seed, "push", "--quiet", "origin", "main");
	// `--no-local`: a local clone hardlinks its objects and skips the transfer the race lives in.
	git(undefined, "clone", "--quiet", "--no-local", remote, clone);
	return {clone, tip: git(seed, "rev-parse", "HEAD").trim()};
};

/** One spawn's base resolution: exactly the three commands the verb runs, in the verb's order. */
const resolveBase = async (clone: string, name: string, nonce: string): Promise<string> => {
	const ref = baseRefFor(name, nonce);
	const git = (args: ReadonlyArray<string>) => run("git", [...args], {cwd: clone, env: GIT_ENV});
	try {
		await git(fetchBaseArgs("main", ref));
		const {stdout} = await git(resolveBaseArgs(ref));
		await git(dropBaseRefArgs(ref));
		return stdout.trim();
	} catch (cause) {
		// `rev-parse --quiet` says nothing when the ref it was pointed at held nothing, which is
		// precisely the shared-`FETCH_HEAD` loss — so name it rather than reporting a blank failure.
		const stderr = String((cause as {stderr?: string}).stderr ?? (cause as Error).message).trim();
		return `FAILED: ${stderr === "" ? "the base ref resolved to no commit" : stderr.split("\n").join(" | ")}`;
	}
};

afterAll(() => {
	for (const root of roots) rmSync(root, {recursive: true, force: true});
});

describe("resolving the base under parallel spawns", () => {
	it("gives every one of N concurrent spawns the same fetched tip, with no lost base", async () => {
		const {clone, tip} = openClone();
		expect(isCommitId(tip)).toBe(true);

		const resolved: string[] = [];
		for (let round = 0; round < ROUNDS; round++) {
			resolved.push(
				...(await Promise.all(
					Array.from({length: SPAWNS}, (_, i) => resolveBase(clone, "agent", `${round}-${i}`)),
				)),
			);
		}

		expect(resolved).toHaveLength(SPAWNS * ROUNDS);
		// Asserted as a set so a failure prints the losing spawn's own diagnostics, not `16 !== 320`.
		expect(new Set(resolved)).toEqual(new Set([tip]));
	}, 120_000);

	it("leaves no per-spawn ref behind, so a clone does not accumulate one ref per spawn ever made", async () => {
		const {clone, tip} = openClone();
		expect(await resolveBase(clone, "agent-solo", "abcdef012345")).toBe(tip);
		const refs = execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/fabrika/"], {
			cwd: clone,
			env: GIT_ENV,
			encoding: "utf8",
		});
		expect(refs.trim()).toBe("");
	});
});

describe("the per-spawn base ref", () => {
	it("is unique per spawn even when two slugs differ only in punctuation", () => {
		expect(baseRefFor("agent.1", "aaaa")).not.toBe(baseRefFor("agent-1", "bbbb"));
	});

	it("carries no refname git rejects, whatever the slug the harness suggested", () => {
		for (const name of ["agent..1", "agent.lock", "a.b.c", "Agent_9"]) {
			const ref = baseRefFor(name, "0123456789ab");
			expect(() =>
				execFileSync("git", ["check-ref-format", ref], {env: GIT_ENV, stdio: "ignore"}),
			).not.toThrow();
		}
	});
});
