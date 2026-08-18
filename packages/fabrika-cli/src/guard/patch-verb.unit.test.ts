/**
 * `guard patch-guard check`'s IO boundary and exit taxonomy, over a scripted filesystem — the
 * `gate.unit.test.ts` cases from `pipeline-cli`, re-seated on the three guard exit codes.
 *
 * The marker tag is assembled at runtime (`TAG`) rather than written contiguously, so this file —
 * itself a `*.test.ts` the real-tree scan reads — never contributes a stray pin marker of its own.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {runPatchGuard} from "./patch-verb.ts";

const TAG = ["@patch", "pin:"].join("-");

const ROOT = "/repo";
const WORKSPACE = `${ROOT}/pnpm-workspace.yaml`;

const THREE = ["@nkzw/fate@1.3.1", "alchemy@2.0.0-beta.59", "react-fate@1.3.1"] as const;

const workspace = (patches: ReadonlyArray<string>): string =>
	`packages:\n  - packages/*\npatchedDependencies:\n${patches
		.map((p) => `  '${p}': patches/${p.replace(/[@/]/g, "_")}.patch`)
		.join("\n")}\n`;

const pinned = (key: string): string => `// ${TAG} ${key}\nimport {expect} from "vitest";\n`;

/** Every directory implied by the file paths, so the fake can answer `readDirectory` for the walk. */
const dirsOf = (files: Readonly<Record<string, string>>): Record<string, Array<string>> => {
	const dirs: Record<string, Array<string>> = {[ROOT]: []};
	for (const path of Object.keys(files)) {
		const segments = path.slice(`${ROOT}/`.length).split("/");
		let dir = ROOT;
		for (const [index, segment] of segments.entries()) {
			const listing = dirs[dir] ?? [];
			listing.push(segment);
			dirs[dir] = listing;
			if (index < segments.length - 1) dir = `${dir}/${segment}`;
		}
	}
	return dirs;
};

const repo = (
	patches: ReadonlyArray<string>,
	pins: Readonly<Record<string, string>> = {},
	extra: Partial<FakeFsOptions> = {},
): FakeFsOptions => {
	const files: Record<string, string> = {[WORKSPACE]: workspace(patches)};
	for (const [relative, key] of Object.entries(pins)) files[`${ROOT}/${relative}`] = pinned(key);
	return {files, dirs: dirsOf(files), ...extra};
};

const run = (options: FakeFsOptions, env: Record<string, string | undefined> = {}) =>
	Effect.runPromise(
		Effect.provide(runPatchGuard({root: ROOT, cwd: ROOT, env}), fakeFs(options).layer),
	);

const ALL_PINNED = {
	"apps/web/src/fate/nkzw.test.ts": THREE[0],
	"apps/web/tests/integration/flagship.test.ts": THREE[1],
	"apps/web/src/fate/useView.test.tsx": THREE[2],
};

describe("runPatchGuard", () => {
	it("passes when every patched dep carries a matching pin (the on-main state)", async () => {
		const outcome = await run(repo(THREE, ALL_PINNED));
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("all 3 maintained patches carry a behavior pin");
		expect(outcome.stderr).toEqual([]);
	});

	it("ignores markers under node_modules and .claude — the gap still reds", async () => {
		const outcome = await run(
			repo([THREE[1]], {
				"node_modules/pkg/x.test.ts": THREE[1],
				".claude/worktrees/sib/y.test.ts": THREE[1],
			}),
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain(THREE[1]);
	});

	// Traversal semantics are part of the contract: a symlinked DIR is out of scope and a symlinked
	// FILE is in scope. Without the guard in `gatherMarkers` the first flips a real red to green.
	it("does not recurse a symlinked directory — a pin only reachable through one leaves the patch unpinned", async () => {
		const outcome = await run(
			repo(
				[THREE[1]],
				{"linked/pinned.test.ts": THREE[1]},
				{real: {[`${ROOT}/linked`]: "/outside"}},
			),
		);
		expect(outcome.code).toBe(VIOLATION);
	});

	it("does scan a symlinked file — a pin behind a linked *.test.ts still satisfies the patch", async () => {
		const outcome = await run(
			repo(
				[THREE[1]],
				{"apps/web/tests/linked.test.ts": THREE[1]},
				{real: {[`${ROOT}/apps/web/tests/linked.test.ts`]: "/outside/pinned.test.ts"}},
			),
		);
		expect(outcome.code).toBe(0);
	});

	it("reds an unpinned patch on the violation seat and annotates the workspace file", async () => {
		const outcome = await run(
			repo(THREE, {
				"apps/web/src/fate/nkzw.test.ts": THREE[0],
				"apps/web/tests/integration/flagship.test.ts": THREE[1],
			}),
			{GITHUB_ACTIONS: "true"},
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("react-fate@1.3.1");
		expect(
			outcome.stderr.some((line) => line.startsWith("::error file=pnpm-workspace.yaml::")),
		).toBe(true);
	});

	it("reds a stale pin and annotates the test file carrying it", async () => {
		const outcome = await run(
			repo([THREE[1]], {
				"apps/web/tests/integration/flagship.test.ts": THREE[1],
				"apps/web/tests/integration/stale.test.ts": "alchemy@2.0.0-beta.1",
			}),
			{GITHUB_ACTIONS: "true"},
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(
			outcome.stderr.some((line) =>
				line.startsWith("::error file=apps/web/tests/integration/stale.test.ts::"),
			),
		).toBe(true);
	});

	it("emits no annotation off a runner", async () => {
		const outcome = await run(repo(THREE, {}));
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.some((line) => line.startsWith("::"))).toBe(false);
	});

	// ADR 0092's floor: nothing in scope cannot report clean.
	it("fails closed when patchedDependencies is empty", async () => {
		const outcome = await run(repo([], {"apps/web/tests/orphan.test.ts": THREE[1]}));
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("ZERO patchedDependencies");
	});

	it("fails closed when the workspace file is absent", async () => {
		const outcome = await run({files: {}, dirs: {[ROOT]: []}});
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("does not exist");
	});

	it("answers UNKNOWN when the workspace file cannot be read", async () => {
		const outcome = await run({...repo(THREE, ALL_PINNED), unreadable: [WORKSPACE]});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("answers UNKNOWN when a test file in the tree cannot be read", async () => {
		const outcome = await run({
			...repo(THREE, ALL_PINNED),
			unreadable: [`${ROOT}/apps/web/src/fate/nkzw.test.ts`],
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("nkzw.test.ts");
	});

	it("answers UNKNOWN when no repo root sits above the cwd", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				runPatchGuard({root: null, cwd: "/nowhere", env: {}}),
				fakeFs({files: {}}).layer,
			),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("no repo root");
	});
});
