/**
 * `guard pointer-guard check`'s two seams — the git listing and the on-disk resolution — over a
 * scripted filesystem and a scripted spawner, plus the exit taxonomy.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs, fakeShell} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {runPointerGuard} from "./pointer-verb.ts";

const ROOT = "/repo";

const okResult = (stdout: string): ExecResult => ({ok: true, stdout, reason: ""});
const failResult = (reason: string): ExecResult => ({ok: false, stdout: "", reason});

/** `ls-files` answers the named docs; nothing is gitignored unless a case says so. */
const shell = (
	docs: ReadonlyArray<string>,
	ignored: ReadonlyArray<string> = [],
	listing: ExecResult = okResult(docs.map((doc) => `${doc}\0`).join("")),
) =>
	fakeShell([
		[/ls-files/, listing],
		...ignored.map(
			(path) =>
				[
					new RegExp(`check-ignore .* ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
					okResult(""),
				] as const,
		),
		[/check-ignore/, failResult("not ignored")],
	]);

const run = (
	fsOptions: FakeFsOptions,
	docs: ReadonlyArray<string>,
	ignored: ReadonlyArray<string> = [],
	listing?: ExecResult,
	env: Record<string, string | undefined> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runPointerGuard({root: ROOT, cwd: ROOT, env}),
			Layer.merge(fakeFs(fsOptions).layer, shell(docs, ignored, listing).layer),
		),
	);

const tree = (
	files: Readonly<Record<string, string>>,
	present: ReadonlyArray<string> = [],
): FakeFsOptions => ({
	files: {
		...Object.fromEntries(Object.entries(files).map(([n, t]) => [`${ROOT}/${n}`, t])),
		...Object.fromEntries(present.map((n) => [`${ROOT}/${n}`, ""])),
	},
});

describe("runPointerGuard", () => {
	it("passes when every backticked pointer resolves", async () => {
		const outcome = await run(
			tree({"CLAUDE.md": "see `apps/web/index.ts`"}, ["apps/web/index.ts"]),
			["CLAUDE.md"],
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("no stale CLAUDE.md pointers (1 file(s) scanned)");
		expect(outcome.stderr).toEqual([]);
	});

	it("reds a pointer whose target is gone, naming file, line and path", async () => {
		const outcome = await run(tree({"CLAUDE.md": "\nsee `apps/web/gone.ts`"}), ["CLAUDE.md"]);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("CLAUDE.md:2  →  apps/web/gone.ts");
	});

	// The load-bearing case: CLAUDE.md points at a generated path the doc tells you to create.
	it("treats a gitignored absent path as resolved", async () => {
		const outcome = await run(
			tree({"CLAUDE.md": "run `cp` into `apps/web/.env`"}),
			["CLAUDE.md"],
			["apps/web/.env"],
		);
		expect(outcome.code).toBe(0);
	});

	it("scans every tracked CLAUDE.md, not only the root one", async () => {
		const outcome = await run(
			tree({"CLAUDE.md": "ok", "apps/web/CLAUDE.md": "see `apps/web/gone.ts`"}),
			["CLAUDE.md", "apps/web/CLAUDE.md"],
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("apps/web/CLAUDE.md:1");
	});

	it("annotates each stale pointer on its own line under Actions", async () => {
		const outcome = await run(
			tree({"CLAUDE.md": "see `apps/web/gone.ts`"}),
			["CLAUDE.md"],
			[],
			undefined,
			{GITHUB_ACTIONS: "true"},
		);
		expect(outcome.stderr.some((line) => line.startsWith("::error file=CLAUDE.md,line=1::"))).toBe(
			true,
		);
	});

	it("emits no annotation off a runner", async () => {
		const outcome = await run(tree({"CLAUDE.md": "see `apps/web/gone.ts`"}), ["CLAUDE.md"]);
		expect(outcome.stderr.some((line) => line.startsWith("::"))).toBe(false);
	});

	it("fails closed when no tracked CLAUDE.md is in scope", async () => {
		const outcome = await run(tree({}), []);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("ZERO");
	});

	// A `git` that cannot run reads as "not ignored" at the check-ignore seam, which would turn every
	// pointer stale. Listing first is what keeps that on the UNKNOWN seat.
	it("answers UNKNOWN when git cannot list the tracked docs", async () => {
		const outcome = await run(tree({}), [], [], failResult("not a git repository"));
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("git did not answer");
	});

	it("answers UNKNOWN when a tracked doc cannot be read", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				runPointerGuard({root: ROOT, cwd: ROOT, env: {}}),
				Layer.merge(
					fakeFs({...tree({"CLAUDE.md": "x"}), unreadable: [`${ROOT}/CLAUDE.md`]}).layer,
					shell(["CLAUDE.md"]).layer,
				),
			),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN");
	});
});
