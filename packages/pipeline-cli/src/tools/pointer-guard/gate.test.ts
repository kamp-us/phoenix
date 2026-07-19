/**
 * `checkPointers` / `scanStalePointers` over a fake git repo — the filesystem-seam
 * test (#855, #988). The pure extraction/precision logic is covered in
 * `pointer-guard.unit.test.ts`; this crosses the IO gate over a real temp dir,
 * asserting the exit-code contract (a clean tree succeeds; a stale pointer or a
 * zero-CLAUDE.md scope `CheckFailed`s) from observable outcomes — never by spawning
 * the bin. The git-tracked boundary and nested-CLAUDE.md scope are exercised too.
 */
import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit, type FileSystem, type Path} from "effect";
import {type CheckFailed, checkPointers, scanStalePointers} from "./gate.ts";

// The gate Effects require the `FileSystem | Path` seam (v4 platform migration, #3469);
// provide the live Node layer — the same NodeServices.layer run.ts gives the bin — so these
// real-git-repo IO tests exercise the actual disk path they assert over.
const runP = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
	Effect.runPromise(Effect.provide(effect, NodeServices.layer));
const runExit = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
	Effect.runPromiseExit(Effect.provide(effect, NodeServices.layer));

/** A throwaway git repo so `git ls-files` has something to enumerate. */
const makeRepo = (files: Record<string, string>): string => {
	const dir = mkdtempSync(join(tmpdir(), "pointer-guard-"));
	for (const [rel, content] of Object.entries(files)) {
		const p = join(dir, rel);
		mkdirSync(join(p, ".."), {recursive: true});
		writeFileSync(p, content, "utf8");
	}
	execFileSync("git", ["-C", dir, "init", "-q"]);
	execFileSync("git", ["-C", dir, "add", "-A"]);
	return dir;
};

describe("scanStalePointers", () => {
	it("flags a dead backticked pointer, ignores a live one + non-path tokens", async () => {
		const dir = makeRepo({
			"CLAUDE.md": [
				"live: `apps/web/real.ts`",
				"dead: `apps/web/gone.ts`",
				"not a path: `catalog:` `pnpm dev` `type:bug`",
			].join("\n"),
			"apps/web/real.ts": "ok",
		});
		try {
			const stale = await runP(scanStalePointers(dir));
			assert.deepStrictEqual(
				stale.map((s) => ({file: s.file, path: s.path})),
				[{file: "CLAUDE.md", path: "apps/web/gone.ts"}],
			);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);

	it("scans a nested CLAUDE.md too (consuming-repo per-app file)", async () => {
		const dir = makeRepo({
			"CLAUDE.md": "root ok: `packages/x/y.ts`",
			"packages/x/y.ts": "ok",
			"apps/web/CLAUDE.md": "nested dead: `apps/web/missing.ts`",
		});
		try {
			const stale = await runP(scanStalePointers(dir));
			assert.deepStrictEqual(
				stale.map((s) => s.path),
				["apps/web/missing.ts"],
			);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);

	it("treats a gitignored pointer as resolved (a deliberately-absent runtime file)", async () => {
		const dir = makeRepo({
			".gitignore": "*.env\n",
			// `apps/web/secret.env` is absent on disk but gitignored — a valid pointer, not rot.
			"CLAUDE.md": "create `apps/web/secret.env` from the example",
		});
		try {
			const stale = await runP(scanStalePointers(dir));
			assert.deepStrictEqual(stale, []);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);

	it("ignores an UNTRACKED CLAUDE.md (git-tracked boundary)", async () => {
		const dir = makeRepo({"CLAUDE.md": "ok `apps/web/real.ts`", "apps/web/real.ts": "ok"});
		try {
			writeFileSync(join(dir, "apps", "web", "CLAUDE.md"), "dead `apps/web/nope.ts`", "utf8");
			const stale = await runP(scanStalePointers(dir));
			assert.deepStrictEqual(stale, []);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);
});

describe("checkPointers", () => {
	it("succeeds (no failure) on a clean repo", async () => {
		const dir = makeRepo({"CLAUDE.md": "`apps/web/real.ts`", "apps/web/real.ts": "ok"});
		try {
			const exit = await runExit(checkPointers(dir));
			assert.isTrue(Exit.isSuccess(exit));
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);

	it("fails CheckFailed with a report on a stale pointer", async () => {
		const dir = makeRepo({"CLAUDE.md": "dead `apps/web/gone.ts`"});
		try {
			const reason = await runP(
				checkPointers(dir).pipe(
					Effect.catchTag("CheckFailed", (e: CheckFailed) => Effect.succeed(e.reason)),
				),
			);
			assert.include(reason, "CLAUDE.md:1");
			assert.include(reason, "apps/web/gone.ts");
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);

	it("fails CheckFailed (fail-closed, ADR 0092) when zero CLAUDE.md are in scope", async () => {
		const dir = makeRepo({"README.md": "no CLAUDE.md here `apps/web/gone.ts`"});
		try {
			const exit = await runExit(checkPointers(dir));
			assert.isTrue(Exit.isFailure(exit));
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);
});
