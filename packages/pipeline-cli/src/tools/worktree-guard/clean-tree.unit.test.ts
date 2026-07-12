import {assert, describe, it} from "@effect/vitest";
import {decideCleanTree} from "./clean-tree.ts";

const WT = "/Users/dev/code/phoenix/.claude/worktrees/wf_abc123";

describe("decideCleanTree — the fail-closed clean-tree assertion (#2666)", () => {
	it("certifies an empty porcelain reading as clean", () => {
		const d = decideCleanTree({path: WT, porcelain: ""});
		assert.strictEqual(d.kind, "clean");
	});

	it("treats a whitespace-only reading as clean (trailing newline from git)", () => {
		assert.strictEqual(decideCleanTree({path: WT, porcelain: "\n"}).kind, "clean");
	});

	it("flags a non-empty porcelain reading as dirty (the #2666 unauthored hunk)", () => {
		const d = decideCleanTree({path: WT, porcelain: " M apps/web/worker/foo.ts\n"});
		assert.strictEqual(d.kind, "dirty");
		if (d.kind === "dirty") assert.match(d.reason, /DIRTY/);
	});

	it("flags an untracked entry as dirty", () => {
		assert.strictEqual(decideCleanTree({path: WT, porcelain: "?? stray.txt\n"}).kind, "dirty");
	});

	// Fail-closed: an indeterminate reading (git could not run) is DIRTY, never a false clean.
	it("treats a null reading (git status could not run) as dirty — fail-closed", () => {
		const d = decideCleanTree({path: WT, porcelain: null});
		assert.strictEqual(d.kind, "dirty");
		if (d.kind === "dirty") assert.match(d.reason, /fail-closed/);
	});

	it("bounds the dirty preview to the first entries", () => {
		const many = Array.from({length: 30}, (_, i) => ` M f${i}.ts`).join("\n");
		const d = decideCleanTree({path: WT, porcelain: many});
		assert.strictEqual(d.kind, "dirty");
		// preview caps at 10 lines, so the 20th entry never appears in the reason
		if (d.kind === "dirty") assert.notMatch(d.reason, /f25\.ts/);
	});
});
