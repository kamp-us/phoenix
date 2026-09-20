/**
 * `lane refresh` against real git — the drift the unit tier cannot show.
 *
 * A scripted spawner answers whatever the script says regardless of what the tree holds, so it can
 * pin the order and not the outcome. Here the tree decides: the assembly branch is cut before trunk
 * moves, the verb fetches the real remote, and whether the merge is clean or a conflict is git's
 * answer over two real commits rather than a canned exit code.
 */
import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {MERGE_CONFLICT} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const EPIC = 8810;

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
	execFileSync("git", args, {cwd, encoding: "utf8"}).trim();

interface Fixture {
	readonly root: string;
	readonly seat: string;
	readonly lanes: string;
	/** The assembly branch's head before the refresh — what a refusal must prove it back at. */
	readonly cut: string;
}

/**
 * A clone whose assembly worktree was placed before trunk moved, so `origin/main` is ahead of
 * `epic/<n>` — the state every epic run drifts into while its children build.
 *
 * `collide` decides whether the trunk commit touches the same lines the assembly branch did, which
 * is the whole difference between the clean merge and the conflict.
 */
const fixture = (collide: boolean): Fixture => {
	const home = mkdtempSync(join(tmpdir(), "lane-refresh-"));
	const origin = join(home, "origin.git");
	const seed = join(home, "seed");

	mkdirSync(seed, {recursive: true});
	git(seed, "init", "--initial-branch=main", ".");
	git(seed, "config", "user.email", "refresh@example.test");
	git(seed, "config", "user.name", "refresh");
	writeFileSync(join(seed, ".gitignore"), ".fabrika/\n");
	writeFileSync(join(seed, "shared.txt"), "base\n");
	git(seed, "add", "-A");
	git(seed, "commit", "-m", "base");
	execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], {encoding: "utf8"});
	git(seed, "remote", "add", "origin", origin);
	git(seed, "push", "-u", "origin", "main");

	const root = join(home, "checkout");
	execFileSync("git", ["clone", origin, root], {encoding: "utf8"});
	git(root, "config", "user.email", "refresh@example.test");
	git(root, "config", "user.name", "refresh");

	const seat = join(root, "assembly");
	git(root, "worktree", "add", "-b", `epic/${EPIC}`, seat, "origin/main");
	writeFileSync(join(seat, collide ? "shared.txt" : "child.txt"), "the epic's own line\n");
	git(seat, "add", "-A");
	git(seat, "commit", "-m", "a child landed on the assembly branch");
	const cut = git(seat, "rev-parse", "HEAD");

	// Trunk moves under the run — the drift that ejects the tail from the merge queue.
	writeFileSync(join(seed, collide ? "shared.txt" : "trunk.txt"), "somebody else's line\n");
	git(seed, "add", "-A");
	git(seed, "commit", "-m", "trunk moved while the epic assembled");
	git(seed, "push", "origin", "main");

	const lanes = join(root, ".fabrika", "lanes");
	mkdirSync(join(lanes, String(EPIC)), {recursive: true});
	writeFileSync(join(lanes, String(EPIC), "workflow.json"), coderTemplateText());
	return {root, seat, lanes, cut};
};

const refresh = ({root, lanes}: Fixture, ...flags: ReadonlyArray<string>) => {
	try {
		const stdout = execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				BIN,
				"lane",
				"refresh",
				String(EPIC),
				"--root",
				lanes,
				...flags,
			],
			{cwd: root, encoding: "utf8", env: process.env},
		);
		return {code: 0, stdout};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string; stderr?: string};
		return {code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? ""};
	}
};

describe("lane refresh over a real assembly worktree behind trunk", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("merges trunk in, parks nothing, and lands on a head it read back", () => {
		const tree = fixture(false);

		const {code, stdout} = refresh(tree);

		expect(code).toBe(0);
		const lines = stdout.trim().split("\n");
		expect(lines.at(-1)).toBe("REFRESH-VERDICT: MERGED");
		// The answered head is the tree's own, not one composed from the merge's exit status.
		expect(lines.at(-2)).toBe(git(tree.seat, "rev-parse", "HEAD"));
		expect(git(tree.seat, "rev-parse", "HEAD")).not.toBe(tree.cut);
		expect(git(tree.seat, "merge-base", "--is-ancestor", "origin/main", "HEAD")).toBe("");
	});

	it("is CURRENT the second time, having merged nothing", () => {
		const tree = fixture(false);
		refresh(tree);
		const merged = git(tree.seat, "rev-parse", "HEAD");

		const {code, stdout} = refresh(tree);

		expect(code).toBe(0);
		expect(stdout.trim().split("\n")).toEqual([merged, "REFRESH-VERDICT: CURRENT"]);
	});

	it("aborts a real conflict, proves the branch back at its pre-refresh head, and names a cause", () => {
		const tree = fixture(true);

		const {code, stderr} = refresh(tree);

		expect(code).toBe(MERGE_CONFLICT);
		expect(git(tree.seat, "rev-parse", "HEAD")).toBe(tree.cut);
		expect(git(tree.seat, "status", "--porcelain", "--untracked-files=no")).toBe("");
		expect(stderr).toContain("--cause assembly-conflict");
	});

	it("declines the automatic call under the shipped key, leaving the branch where it stood", () => {
		const tree = fixture(false);

		const {code, stdout} = refresh(tree, "--on-review");

		expect(code).toBe(0);
		expect(stdout.trim()).toBe("REFRESH-VERDICT: DECLINED");
		expect(git(tree.seat, "rev-parse", "HEAD")).toBe(tree.cut);
	});
});
