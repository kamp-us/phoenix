import {Effect, Path} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {
	chooseRoot,
	discoverRepoRoot,
	globToRegExp,
	manifestWorkspaceGlobs,
	matchesWorkspaceGlobs,
	originOf,
	pnpmWorkspaceGlobs,
} from "./root.ts";

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

/** `chooseRoot` takes the platform `Path` service; a test borrows the real one off its layer. */
const rootOf = (candidates: Parameters<typeof chooseRoot>[1]) =>
	Effect.runSync(
		Effect.gen(function* () {
			return chooseRoot(yield* Path.Path, candidates);
		}).pipe(Effect.provide(Path.layer)),
	);

describe("globToRegExp", () => {
	it("keeps `*` inside one segment, so `packages/*` does not swallow a nested dir", () => {
		expect(globToRegExp("packages/*").test("packages/fabrika-cli")).toBe(true);
		expect(globToRegExp("packages/*").test("packages/a/b")).toBe(false);
	});

	it("lets `**` cross segments", () => {
		expect(globToRegExp("packages/**").test("packages/a/b")).toBe(true);
	});

	it("treats regex metacharacters in a glob as literals", () => {
		expect(globToRegExp("a.b/*").test("a.b/c")).toBe(true);
		expect(globToRegExp("a.b/*").test("axb/c")).toBe(false);
	});
});

describe("matchesWorkspaceGlobs", () => {
	it("matches a member against the root's globs", () => {
		expect(matchesWorkspaceGlobs(["packages/*", "apps/*"], "packages/fabrika-cli")).toBe(true);
	});

	it("refuses a path outside the globs — a nested repo is not this repo's member", () => {
		expect(matchesWorkspaceGlobs(["packages/*"], "vendor/other")).toBe(false);
	});

	it("honours a `!` exclusion", () => {
		expect(matchesWorkspaceGlobs(["packages/*", "!packages/legacy"], "packages/legacy")).toBe(
			false,
		);
	});

	it("never matches the root against itself — an empty relative path is not a member", () => {
		expect(matchesWorkspaceGlobs(["packages/*", "**"], "")).toBe(false);
	});
});

describe("pnpmWorkspaceGlobs", () => {
	it("reads the `packages:` list and stops at the next top-level key", () => {
		const globs = pnpmWorkspaceGlobs(
			["packages:", "  - packages/*", "  - 'apps/*'", "", "catalog:", "  effect: ^4.0.0"].join(
				"\n",
			),
		);
		expect(globs).toEqual(["packages/*", "apps/*"]);
	});

	it("answers empty for a workspace file that declares no packages", () => {
		expect(pnpmWorkspaceGlobs("catalog:\n  effect: ^4.0.0\n")).toEqual([]);
	});
});

describe("manifestWorkspaceGlobs", () => {
	it("reads the array shape", () => {
		expect(manifestWorkspaceGlobs('{"workspaces":["packages/*"]}')).toEqual(["packages/*"]);
	});

	it("reads the `{packages}` shape", () => {
		expect(manifestWorkspaceGlobs('{"workspaces":{"packages":["apps/*"]}}')).toEqual(["apps/*"]);
	});

	it("answers empty — never throws — for a manifest that will not parse", () => {
		expect(manifestWorkspaceGlobs("{not json")).toEqual([]);
	});
});

describe("chooseRoot", () => {
	it("prefers the highest ancestor whose globs claim the closest package", () => {
		expect(
			rootOf([
				{dir: "/repo/packages/fabrika-cli", globs: []},
				{dir: "/repo", globs: ["packages/*"]},
				{dir: "/", globs: []},
			]),
		).toBe("/repo");
	});

	it("falls back to the closest package when no ancestor claims it", () => {
		expect(
			rootOf([
				{dir: "/elsewhere/thing", globs: []},
				{dir: "/elsewhere", globs: ["packages/*"]},
			]),
		).toBe("/elsewhere/thing");
	});

	it("answers undefined when no ancestor holds a package.json at all", () => {
		expect(rootOf([])).toBeUndefined();
	});
});

describe("discoverRepoRoot", () => {
	it("collects EVERY ancestor manifest — it does not stop at the first", async () => {
		const fs = fakeFs({
			files: {
				"/repo/packages/fabrika-cli/package.json": '{"name":"@kampus/fabrika-cli"}',
				"/repo/package.json": '{"name":"phoenix"}',
				"/repo/pnpm-workspace.yaml": "packages:\n  - packages/*\n",
			},
		});
		const root = await run(
			discoverRepoRoot("/repo/packages/fabrika-cli/src").pipe(Effect.provide(fs.layer)),
		);
		expect(root).toBe("/repo");
	});

	it("answers undefined outside any repo — that case is silent, deliberately", async () => {
		const fs = fakeFs({files: {}});
		const root = await run(discoverRepoRoot("/tmp/nowhere").pipe(Effect.provide(fs.layer)));
		expect(root).toBeUndefined();
	});

	it("distinguishes a repo root from an unreadable ancestor — a failed probe FAILS", async () => {
		const fs = fakeFs({files: {}, unprobeable: ["/repo/deep/package.json"]});
		const outcome = await run(
			discoverRepoRoot("/repo/deep").pipe(Effect.provide(fs.layer), Effect.result),
		);
		expect(outcome._tag).toBe("Failure");
	});

	it("finds a repo that pins the package but has not installed it — NOT 'no repo'", async () => {
		const fs = fakeFs({
			files: {
				"/consumer/package.json":
					'{"name":"consumer","devDependencies":{"@kampus/fabrika-cli":"^0.1.0"}}',
			},
		});
		const root = await run(discoverRepoRoot("/consumer/src").pipe(Effect.provide(fs.layer)));
		expect(root).toBe("/consumer");
	});
});

describe("originOf", () => {
	const checkout = (root: string) => ({
		[`${root}/package.json`]: '{"name":"phoenix"}',
		[`${root}/pnpm-workspace.yaml`]: "packages:\n  - packages/*\n",
		[`${root}/packages/fabrika-cli/package.json`]: '{"name":"@kampus/fabrika-cli"}',
	});

	it("names the checkout a source copy belongs to", async () => {
		const fs = fakeFs({files: checkout("/repo")});
		const origin = await run(originOf("/repo/packages/fabrika-cli").pipe(Effect.provide(fs.layer)));
		expect(origin).toEqual({_tag: "checkout", root: "/repo"});
	});

	it("never reports a package as its OWN checkout — the walk starts above it", async () => {
		const fs = fakeFs({files: {"/loose/thing/package.json": '{"name":"thing"}'}});
		const origin = await run(originOf("/loose/thing").pipe(Effect.provide(fs.layer)));
		expect(origin).toEqual({_tag: "no-checkout"});
	});

	/**
	 * `pnpm add --global` writes a `package.json` beside the global `node_modules`, so a plain
	 * ancestor walk answers "checkout" here and the refusal would swallow the delegation the whole
	 * feature exists for.
	 */
	it("answers no-checkout for an install under node_modules, manifest above it or not", async () => {
		const fs = fakeFs({
			files: {
				"/usr/local/pnpm/global/5/package.json": '{"name":"global"}',
				"/usr/local/pnpm/global/5/node_modules/@kampus/fabrika-cli/package.json": "{}",
			},
		});
		const origin = await run(
			originOf("/usr/local/pnpm/global/5/node_modules/@kampus/fabrika-cli").pipe(
				Effect.provide(fs.layer),
			),
		);
		expect(origin).toEqual({_tag: "no-checkout"});
	});

	it("FAILS rather than answering no-checkout when an ancestor cannot be probed", async () => {
		const fs = fakeFs({files: {}, unprobeable: ["/repo/packages/package.json"]});
		const outcome = await run(
			originOf("/repo/packages/fabrika-cli").pipe(Effect.provide(fs.layer), Effect.result),
		);
		expect(outcome._tag).toBe("Failure");
	});
});
