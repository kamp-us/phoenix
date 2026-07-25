/**
 * `checkPatchGuard` over a fake repo dir — the filesystem-seam test (#855, #3051). The
 * pure verdict is covered in `patch-guard.unit.test.ts`; this crosses the IO gate over a
 * real temp dir, asserting the exit-code contract (a fully pinned tree succeeds; an
 * unpinned patch, a stale pin, and a zero-`patchedDependencies` scope all `CheckFailed`)
 * from observable outcomes — never by spawning the bin.
 *
 * The marker tag is assembled at runtime (`TAG`) rather than written contiguously so
 * this file — itself a `*.test.ts` the real-tree scan reads — never contributes a stray
 * pin marker of its own; the fixtures it writes live under an out-of-repo temp dir.
 */
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {afterEach, beforeEach, describe, expect, it} from "@effect/vitest";
import {Cause, Effect, Exit, type FileSystem, type Path} from "effect";
import {CheckFailed, checkPatchGuard} from "./gate.ts";

// The literal marker tag, kept non-contiguous in source (see file docblock).
const TAG = ["@patch", "pin:"].join("-");

let root: string;
// A second temp tree OUTSIDE `root`, so anything the walk reaches in it was reached
// through a symlink planted in `root` and not by ordinary recursion.
let outside: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "patch-guard-gate-"));
	outside = mkdtempSync(join(tmpdir(), "patch-guard-outside-"));
});
afterEach(() => {
	rmSync(root, {recursive: true, force: true});
	rmSync(outside, {recursive: true, force: true});
});

const writeWorkspace = (
	patches: ReadonlyArray<string> = [
		"@nkzw/fate@1.3.1",
		"alchemy@2.0.0-beta.59",
		"react-fate@1.3.1",
	],
) => {
	const block =
		patches.length === 0
			? "patchedDependencies:\n"
			: `patchedDependencies:\n${patches.map((p) => `  '${p}': patches/${p.replace(/[@/]/g, "_")}.patch`).join("\n")}\n`;
	writeFileSync(join(root, "pnpm-workspace.yaml"), `packages:\n  - packages/*\n${block}`, "utf8");
};

/** Write a `*.test.ts` file carrying a pin marker for `key`, at a nested repo path. */
const writePin = (relPath: string, key: string) => {
	writePinAt(join(root, relPath), key);
};

/** `writePin`, addressed absolutely — lets a fixture live outside `root`. */
const writePinAt = (abs: string, key: string) => {
	mkdirSync(dirname(abs), {recursive: true});
	writeFileSync(abs, `// ${TAG} ${key}\nimport {expect} from "vitest";\n`, "utf8");
};

// The gate Effects require the `FileSystem | Path` seam (v4 platform migration, #3472);
// provide the live Node layer — the same NodeServices.layer run.ts gives the bin — so these
// real-temp-dir IO tests exercise the actual disk path they assert over.
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
	Effect.runPromiseExit(Effect.provide(effect, NodeServices.layer));
const isCheckFailed = (exit: Exit.Exit<unknown, unknown>): boolean =>
	Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof CheckFailed;

describe("checkPatchGuard — the CI exit-code gate over a fake repo dir", () => {
	it("SUCCEEDS when every patched dep carries a matching pin (the on-main state)", async () => {
		writeWorkspace();
		writePin("apps/web/src/fate/nkzw.test.ts", "@nkzw/fate@1.3.1");
		writePin("apps/web/tests/integration/flagship.test.ts", "alchemy@2.0.0-beta.59");
		writePin("apps/web/src/fate/useView.test.tsx", "react-fate@1.3.1");
		const exit = await run(checkPatchGuard(root));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("IGNORES markers under ignored dirs (node_modules, .claude) — still catches the gap", async () => {
		writeWorkspace(["alchemy@2.0.0-beta.59"]);
		// a pin buried in node_modules/.claude must NOT count toward the maintained patch
		writePin("node_modules/pkg/x.test.ts", "alchemy@2.0.0-beta.59");
		writePin(".claude/worktrees/sib/y.test.ts", "alchemy@2.0.0-beta.59");
		const exit = await run(checkPatchGuard(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	// Traversal semantics are part of the exit-code contract, so they get pinned here: a
	// symlinked DIR is out of scope and a symlinked FILE is in scope, matching the
	// pre-migration lstat-based walk (see `gatherMarkers`). Without the gate in gate.ts the
	// first of these flips a real red to green — a guard failing open.
	it("does NOT recurse a symlinked directory — a pin only reachable through one leaves the patch UNPINNED", async () => {
		writeWorkspace(["alchemy@2.0.0-beta.59"]);
		writePinAt(join(outside, "pinned.test.ts"), "alchemy@2.0.0-beta.59");
		symlinkSync(outside, join(root, "linked"), "dir");
		const exit = await run(checkPatchGuard(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("DOES scan a symlinked file — a pin behind a linked *.test.ts still satisfies the patch", async () => {
		writeWorkspace(["alchemy@2.0.0-beta.59"]);
		writePinAt(join(outside, "pinned.test.ts"), "alchemy@2.0.0-beta.59");
		mkdirSync(join(root, "apps/web/tests"), {recursive: true});
		symlinkSync(join(outside, "pinned.test.ts"), join(root, "apps/web/tests/linked.test.ts"));
		const exit = await run(checkPatchGuard(root));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("FAILS (CheckFailed) when a patched dep has no pin marker", async () => {
		writeWorkspace();
		writePin("apps/web/src/fate/nkzw.test.ts", "@nkzw/fate@1.3.1");
		writePin("apps/web/tests/integration/flagship.test.ts", "alchemy@2.0.0-beta.59");
		// react-fate@1.3.1 unpinned
		const exit = await run(checkPatchGuard(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("FAILS (CheckFailed) on a stale pin marker (dep/version not in patchedDependencies)", async () => {
		writeWorkspace(["alchemy@2.0.0-beta.59"]);
		writePin("apps/web/tests/integration/flagship.test.ts", "alchemy@2.0.0-beta.59");
		writePin("apps/web/tests/integration/stale.test.ts", "alchemy@2.0.0-beta.1");
		const exit = await run(checkPatchGuard(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("FAILS (fail-closed) when patchedDependencies is empty", async () => {
		writeWorkspace([]);
		writePin("apps/web/tests/integration/orphan.test.ts", "alchemy@2.0.0-beta.59");
		const exit = await run(checkPatchGuard(root));
		expect(isCheckFailed(exit)).toBe(true);
	});
});
