import {assert, describe, it} from "@effect/vitest";
import {mainCheckoutPrefix, resolvePath} from "./path-resolve.ts";

const MAIN = "/Users/dev/code/phoenix";
const WT = `${MAIN}/.claude/worktrees/wf_abc123`;

const never = () => false;
const always = () => true;

describe("mainCheckoutPrefix", () => {
	it("derives the main checkout from the worktree layout", () => {
		assert.strictEqual(mainCheckoutPrefix(WT), MAIN);
		assert.strictEqual(mainCheckoutPrefix(`${WT}/`), MAIN);
	});

	it("returns null for an empty or non-worktree root", () => {
		assert.isNull(mainCheckoutPrefix(""));
		assert.isNull(mainCheckoutPrefix("/some/bespoke/worktree"));
		assert.isNull(mainCheckoutPrefix("/.claude/worktrees/x")); // no main segment to the left
	});
});

describe("resolvePath — the cwd-reset fix (AC: relative path resolves to $WORKTREE_ROOT)", () => {
	it("rewrites a RELATIVE path against $WORKTREE_ROOT, not the (reset) cwd", () => {
		const d = resolvePath({
			worktreeRoot: WT,
			cwd: MAIN, // cwd reset to the main checkout — the documented hazard
			candidatePath: "packages/foo/src/x.ts",
			existsInWorktree: never,
		});
		assert.strictEqual(d.kind, "rewrite");
		if (d.kind === "rewrite") assert.strictEqual(d.absolutePath, `${WT}/packages/foo/src/x.ts`);
	});

	it("resolves `.` and `..` segments in a relative path", () => {
		const d = resolvePath({
			worktreeRoot: WT,
			cwd: MAIN,
			candidatePath: "./a/../b/c.ts",
			existsInWorktree: never,
		});
		assert.strictEqual(d.kind, "rewrite");
		if (d.kind === "rewrite") assert.strictEqual(d.absolutePath, `${WT}/b/c.ts`);
	});
});

describe("resolvePath — absolute paths", () => {
	it("allows an absolute path already inside the worktree", () => {
		const d = resolvePath({
			worktreeRoot: WT,
			cwd: MAIN,
			candidatePath: `${WT}/packages/foo/x.ts`,
			existsInWorktree: never,
		});
		assert.strictEqual(d.kind, "allow");
	});

	it("rewrites a MAIN-checkout path to the worktree copy when one exists", () => {
		const d = resolvePath({
			worktreeRoot: WT,
			cwd: MAIN,
			candidatePath: `${MAIN}/packages/foo/x.ts`,
			existsInWorktree: always,
		});
		assert.strictEqual(d.kind, "rewrite");
		if (d.kind === "rewrite") assert.strictEqual(d.absolutePath, `${WT}/packages/foo/x.ts`);
	});

	it("BLOCKS a MAIN-checkout path with the corrected worktree path when no copy exists", () => {
		const d = resolvePath({
			worktreeRoot: WT,
			cwd: MAIN,
			candidatePath: `${MAIN}/packages/foo/new.ts`,
			existsInWorktree: never,
		});
		assert.strictEqual(d.kind, "block");
		if (d.kind === "block") assert.strictEqual(d.corrected, `${WT}/packages/foo/new.ts`);
	});

	it("allows an absolute path outside both trees (e.g. /tmp)", () => {
		const d = resolvePath({
			worktreeRoot: WT,
			cwd: MAIN,
			candidatePath: "/tmp/scratch.md",
			existsInWorktree: always,
		});
		assert.strictEqual(d.kind, "allow");
	});
});

describe("resolvePath — no-op when not a managed worktree agent (fail-open)", () => {
	it("allows everything when $WORKTREE_ROOT is empty", () => {
		const d = resolvePath({
			worktreeRoot: "",
			cwd: MAIN,
			candidatePath: "packages/foo/x.ts",
			existsInWorktree: always,
		});
		assert.strictEqual(d.kind, "allow");
	});

	it("allows everything when $WORKTREE_ROOT is a bespoke (non-layout) dir", () => {
		const d = resolvePath({
			worktreeRoot: "/some/bespoke/wt",
			cwd: MAIN,
			candidatePath: "packages/foo/x.ts",
			existsInWorktree: always,
		});
		assert.strictEqual(d.kind, "allow");
	});
});
