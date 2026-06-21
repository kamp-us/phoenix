import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit} from "effect";
import {type CheckFailed, checkLinks, scanDeadLinks} from "./gate.ts";

/** A throwaway git repo so `git ls-files` has something to enumerate. */
const makeRepo = (files: Record<string, string>): string => {
	const dir = mkdtempSync(join(tmpdir(), "doc-links-"));
	for (const [rel, content] of Object.entries(files)) {
		const p = join(dir, rel);
		mkdirSync(join(p, ".."), {recursive: true});
		writeFileSync(p, content, "utf8");
	}
	execFileSync("git", ["-C", dir, "init", "-q"]);
	execFileSync("git", ["-C", dir, "add", "-A"]);
	return dir;
};

describe("scanDeadLinks", () => {
	it("finds a dead relative link, ignores live + external + code-span ones", async () => {
		const dir = makeRepo({
			"a.md": [
				"[live](./b.md)",
				"[dead](./gone.md)",
				"[ext](https://x.com)",
				"example: `[x](relative/path.md)`",
			].join("\n"),
			"b.md": "ok",
		});
		try {
			const dead = await Effect.runPromise(scanDeadLinks(dir));
			assert.deepStrictEqual(
				dead.map((d) => ({file: d.file, target: d.target})),
				[{file: "a.md", target: "./gone.md"}],
			);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);

	it("resolves an absolute target against the repo root", async () => {
		const dir = makeRepo({
			"docs/a.md": "[root](/b.md) [bad](/missing.md)",
			"b.md": "ok",
		});
		try {
			const dead = await Effect.runPromise(scanDeadLinks(dir));
			assert.deepStrictEqual(
				dead.map((d) => d.target),
				["/missing.md"],
			);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);

	it("ignores an UNTRACKED .md (git-tracked boundary)", async () => {
		const dir = makeRepo({"a.md": "[ok](./a.md)"});
		try {
			writeFileSync(join(dir, "untracked.md"), "[dead](./nope.md)", "utf8");
			const dead = await Effect.runPromise(scanDeadLinks(dir));
			assert.deepStrictEqual(dead, []);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);
});

describe("checkLinks", () => {
	it("succeeds (no failure) on a clean repo", async () => {
		const dir = makeRepo({"a.md": "[self](./a.md)"});
		try {
			const exit = await Effect.runPromiseExit(checkLinks(dir));
			assert.isTrue(Exit.isSuccess(exit));
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);

	it("fails CheckFailed with a report on a dead link", async () => {
		const dir = makeRepo({"a.md": "[dead](./gone.md)"});
		try {
			const exit = await Effect.runPromiseExit(checkLinks(dir));
			assert.isTrue(Exit.isFailure(exit));
			const err = exit._tag === "Failure" ? exit.cause : undefined;
			// the failure is the CheckFailed reason carrying the report
			const reason = await Effect.runPromise(
				checkLinks(dir).pipe(
					Effect.catchTag("CheckFailed", (e: CheckFailed) => Effect.succeed(e.reason)),
				),
			);
			assert.include(reason, "a.md:1");
			assert.include(reason, "./gone.md");
			assert.isDefined(err);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);
});
