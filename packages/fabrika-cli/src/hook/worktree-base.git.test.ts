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
 * The per-spawn ref that fixed it left a second, rarer race on the directory those names *shared*,
 * which surfaced here as an intermittent `cannot lock ref` (#7428). That one is settled by where
 * {@link baseRefFor} puts its leaf, so it is pinned in the last describe rather than raced for: the
 * observed rate was one loss in 320 pairs, far below what this file's load would catch reliably.
 *
 * What is exercised is the derivation the verb performs — the argv from {@link fetchBaseArgs},
 * {@link resolveBaseArgs} and {@link dropBaseRefArgs}, and the guard in {@link isCommitId}. The
 * Effect wrapper around them folds the same pieces over a scripted spawner elsewhere; running it
 * here would mean standing up a spawner layer per concurrent spawn to prove a property that is
 * git's, not Effect's.
 *
 * `git worktree add` is deliberately **not** in the loop. It carries two concurrency faults of its
 * own — a sibling's null-oid `worktrees/<name>/HEAD` placeholder breaking a concurrent fetch's
 * connectivity check, and `failed to read …/commondir` between two adds — so including it would make
 * this file red for reasons it is not judging. Those two are `worktree-concurrency.git.test.ts`'s
 * subject (#7331), over the same {@link openClone} fixture.
 */
import {execFile, execFileSync} from "node:child_process";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {promisify} from "node:util";
import {afterAll, describe, expect, it} from "vitest";
import {GIT_ENV, openClone, removeClones} from "./throwaway-clone.test-support.ts";
import {
	baseRefFor,
	dropBaseRefArgs,
	fetchBaseArgs,
	isCommitId,
	resolveBaseArgs,
} from "./worktree-create.ts";

const run = promisify(execFile);

const SPAWNS = 16;
const ROUNDS = 20;

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

afterAll(removeClones);

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

	// #7428: a per-spawn *name* still left a shared *directory* for `update-ref -d` to rmdir out from
	// under a sibling's in-flight fetch. What makes the leaf safe is which component it sits in, so
	// that is what is pinned — a future nesting that reintroduces the race reds here.
	it("puts its leaf directly in `refs/fabrika/`, the deepest directory `update-ref -d` cannot prune", () => {
		const ref = baseRefFor("agent", "0123456789ab");
		expect(ref.startsWith("refs/fabrika/")).toBe(true);
		expect(ref.split("/")).toHaveLength(3);
	});

	it("leaves the directory its leaf lived in behind, so a sibling's fetch can still lock a ref there", async () => {
		const {clone, tip} = openClone();
		expect(await resolveBase(clone, "agent-alone", "0123456789ab")).toBe(tip);

		// `update-ref -d` prunes every parent it empties, floored two components in. That leaf was the
		// only ref under its directory, so a prunable directory would be gone by now.
		const ref = baseRefFor("agent-alone", "0123456789ab");
		const leafDir = join(clone, ".git", ref.slice(0, ref.lastIndexOf("/")));
		expect(existsSync(leafDir)).toBe(true);
	});
});
