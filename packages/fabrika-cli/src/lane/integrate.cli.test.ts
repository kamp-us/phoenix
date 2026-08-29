/**
 * `lane integrate` against real git — the #7162 shape, reproduced.
 *
 * The unit tier pins the order the verb runs its steps in. What it cannot show is that the order is
 * the thing that fixes anything, because a scripted spawner answers whatever the script says
 * regardless of what the tree holds. Here the tree decides: the validator passes only when the
 * install it reads was made from the lockfile the merge brought, so an assembly worktree carrying
 * the pre-merge install reds, and the same tree reconciled first goes green — with no source and no
 * lockfile change between the two runs (#7188).
 */
import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {ASSEMBLY_RED, RECONCILE_REFUSED} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const EPIC = 7140;
const CHILD = "build/7162-tuval-bootstrap";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
	execFileSync("git", args, {cwd, encoding: "utf8"}).trim();

/** The install a repo declares: record what the lockfile currently pins. */
const INSTALL = "cp lock.txt .installed\n";
/** The install that repairs rather than honours the lockfile — the refusal of criterion 5. */
const REWRITING_INSTALL = "cp lock.txt .installed\nprintf repaired > lock.txt\n";
/** The validator: the tree only compiles when the install matches the lockfile beside it. */
const VALIDATE = "cmp -s lock.txt .installed\n";

const config = (reconciler: string | null) =>
	JSON.stringify({
		...(reconciler === null ? {} : {dependencyReconciler: {command: ["sh", reconciler]}}),
		codeValidators: [{command: ["sh", "validate.sh"]}],
	});

interface Fixture {
	readonly root: string;
	readonly seat: string;
	readonly lanes: string;
	readonly base: string;
}

/**
 * A repo whose assembly worktree was placed before the child existed, so its `.installed` is the
 * pre-merge one — exactly the state #7162's lane was in when it merged.
 */
const fixture = (reconciler: string | null): Fixture => {
	const root = join(mkdtempSync(join(tmpdir(), "lane-integrate-")), "checkout");
	mkdirSync(root, {recursive: true});
	git(root, "init", "--initial-branch=main", ".");
	git(root, "config", "user.email", "integrate@example.test");
	git(root, "config", "user.name", "integrate");
	writeFileSync(join(root, ".gitignore"), ".installed\n.fabrika/\n");
	writeFileSync(join(root, "lock.txt"), "v1");
	writeFileSync(join(root, "install.sh"), INSTALL);
	writeFileSync(join(root, "rewriting-install.sh"), REWRITING_INSTALL);
	writeFileSync(join(root, "validate.sh"), VALIDATE);
	writeFileSync(join(root, ".fabrika.jsonc"), config(reconciler));
	git(root, "add", "-A");
	git(root, "commit", "-m", "base");
	const base = git(root, "rev-parse", "HEAD");

	git(root, "branch", CHILD);
	git(root, "checkout", CHILD);
	mkdirSync(join(root, "pkg"), {recursive: true});
	writeFileSync(join(root, "pkg", "package.json"), '{"name":"tuval"}\n');
	writeFileSync(join(root, "lock.txt"), "v2");
	git(root, "add", "-A");
	git(root, "commit", "-m", "child adds a workspace package and moves the lockfile");
	git(root, "checkout", "main");

	const seat = join(root, "assembly");
	git(root, "worktree", "add", "-b", `epic/${EPIC}`, seat, base);
	// The whole defect: the seat's install predates the child, and nothing reconciles it.
	writeFileSync(join(seat, ".installed"), "v1");

	const lanes = join(root, ".fabrika", "lanes");
	mkdirSync(join(lanes, String(EPIC)), {recursive: true});
	writeFileSync(join(lanes, String(EPIC), "workflow.json"), coderTemplateText());
	return {root, seat, lanes, base};
};

const integrate = ({root, lanes}: Fixture) => {
	try {
		const stdout = execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				BIN,
				"lane",
				"integrate",
				String(EPIC),
				"--child",
				CHILD,
				"--root",
				lanes,
			],
			{cwd: root, encoding: "utf8", env: process.env},
		);
		return {code: 0, stdout};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string};
		return {code: failure.status ?? -1, stdout: failure.stdout ?? ""};
	}
};

describe("lane integrate over a real assembly worktree", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("reconciles the merged lockfile, so the validators judge the merge and not the stale install", () => {
		const tree = fixture("install.sh");

		const {code, stdout} = integrate(tree);

		expect(code).toBe(0);
		expect(stdout.trim().split("\n").at(-1)).toBe("INTEGRATE-VERDICT: MERGED");
		expect(git(tree.seat, "rev-parse", "HEAD")).not.toBe(tree.base);
		expect(git(tree.seat, "log", "-1", "--format=%s")).toContain("Merge");
	});

	it("is the #7162 red without that step: the same tree, the same child, no install between", () => {
		const tree = fixture(null);

		const {code} = integrate(tree);

		expect(code).toBe(ASSEMBLY_RED);
		// The refusal put the branch back, so the run's next act cannot publish the bad merge.
		expect(git(tree.seat, "rev-parse", "HEAD")).toBe(tree.base);
	});

	it("refuses an install that rewrote the lockfile, leaving the branch unpublished and reset", () => {
		const tree = fixture("rewriting-install.sh");

		const {code} = integrate(tree);

		expect(code).toBe(RECONCILE_REFUSED);
		expect(git(tree.seat, "rev-parse", "HEAD")).toBe(tree.base);
		expect(git(tree.seat, "status", "--porcelain", "--untracked-files=no")).toBe("");
	});
});
