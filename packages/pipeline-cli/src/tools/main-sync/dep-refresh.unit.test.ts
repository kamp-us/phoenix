import {assert, describe, it} from "@effect/vitest";
import {
	changedPathsForceDepRefresh,
	decidePnpmVersionGuard,
	depPathsForcingRefresh,
	type PnpmVersion,
	parsePackageManagerPnpm,
	parsePnpmVersionOutput,
	pathForcesDepRefresh,
} from "./dep-refresh.ts";

describe("pathForcesDepRefresh — which pulled paths make node_modules stale", () => {
	it("the lockfile forces a refresh", () => {
		assert.strictEqual(pathForcesDepRefresh("pnpm-lock.yaml"), true);
	});

	it("any path under patches/ forces a refresh", () => {
		assert.strictEqual(pathForcesDepRefresh("patches/effect@3.11.0.patch"), true);
		assert.strictEqual(pathForcesDepRefresh("patches/@scope__pkg@1.0.0.patch"), true);
	});

	it("an unrelated source/doc path does NOT force a refresh", () => {
		assert.strictEqual(pathForcesDepRefresh("apps/web/src/App.tsx"), false);
		assert.strictEqual(pathForcesDepRefresh("README.md"), false);
		assert.strictEqual(pathForcesDepRefresh("package.json"), false);
	});

	it("a nested lockfile is NOT the root lockfile — exact match only", () => {
		// Only the root `pnpm-lock.yaml` drives the install; a same-named file elsewhere is not it.
		assert.strictEqual(pathForcesDepRefresh("apps/web/pnpm-lock.yaml"), false);
	});

	it("a path merely containing 'patches' but not under patches/ does NOT force a refresh", () => {
		assert.strictEqual(pathForcesDepRefresh("apps/web/src/patches.ts"), false);
		assert.strictEqual(pathForcesDepRefresh("docs/patches/notes.md"), false);
	});
});

describe("depPathsForcingRefresh / changedPathsForceDepRefresh — over a pulled set", () => {
	it("returns only the dep-forcing subset (the reportable why)", () => {
		const pulled = [
			"apps/web/src/App.tsx",
			"patches/effect@3.11.0.patch",
			"README.md",
			"pnpm-lock.yaml",
		];
		assert.deepStrictEqual(depPathsForcingRefresh(pulled), [
			"patches/effect@3.11.0.patch",
			"pnpm-lock.yaml",
		]);
		assert.strictEqual(changedPathsForceDepRefresh(pulled), true);
	});

	it("an empty pull (no-op ff) forces nothing", () => {
		assert.deepStrictEqual(depPathsForcingRefresh([]), []);
		assert.strictEqual(changedPathsForceDepRefresh([]), false);
	});

	it("a code-only pull forces nothing", () => {
		const pulled = ["apps/web/src/App.tsx", "packages/pipeline-cli/src/x.ts"];
		assert.deepStrictEqual(depPathsForcingRefresh(pulled), []);
		assert.strictEqual(changedPathsForceDepRefresh(pulled), false);
	});
});

describe("parsePackageManagerPnpm — the required version from the packageManager pin", () => {
	it("parses `pnpm@10.27.0`", () => {
		assert.deepStrictEqual(parsePackageManagerPnpm("pnpm@10.27.0"), {
			version: "10.27.0",
			major: 10,
		});
	});

	it("absorbs a corepack integrity hash tail", () => {
		assert.deepStrictEqual(parsePackageManagerPnpm("pnpm@10.27.0+sha512.abc123"), {
			version: "10.27.0",
			major: 10,
		});
	});

	it("is null for a different package manager", () => {
		assert.strictEqual(parsePackageManagerPnpm("yarn@4.0.0"), null);
		assert.strictEqual(parsePackageManagerPnpm("npm@10.0.0"), null);
	});

	it("is null when absent or malformed (fail-closed: required unknown)", () => {
		assert.strictEqual(parsePackageManagerPnpm(undefined), null);
		assert.strictEqual(parsePackageManagerPnpm(""), null);
		assert.strictEqual(parsePackageManagerPnpm("pnpm"), null);
		assert.strictEqual(parsePackageManagerPnpm("pnpm@10"), null);
	});
});

describe("parsePnpmVersionOutput — the resolved version from `pnpm --version`", () => {
	it("parses a bare semver line", () => {
		assert.deepStrictEqual(parsePnpmVersionOutput("10.27.0\n"), {version: "10.27.0", major: 10});
	});

	it("reads the wrong-major bare-PATH pnpm (the #3498 bug)", () => {
		assert.deepStrictEqual(parsePnpmVersionOutput("8.15.6"), {version: "8.15.6", major: 8});
	});

	it("takes only the first whitespace-delimited token", () => {
		assert.deepStrictEqual(parsePnpmVersionOutput("10.27.0 (extra noise)"), {
			version: "10.27.0",
			major: 10,
		});
	});

	it("is null on empty / non-semver output (probe didn't resolve → fail-closed)", () => {
		assert.strictEqual(parsePnpmVersionOutput(""), null);
		assert.strictEqual(parsePnpmVersionOutput("command not found"), null);
		assert.strictEqual(parsePnpmVersionOutput("\n\n"), null);
	});
});

describe("decidePnpmVersionGuard — only an equal-major pair authorizes the install", () => {
	const v = (version: string, major: number): PnpmVersion => ({version, major});

	it("equal major → ok (install may run)", () => {
		assert.deepStrictEqual(decidePnpmVersionGuard(v("10.27.0", 10), v("10.27.0", 10)), {
			ok: true,
			resolved: v("10.27.0", 10),
		});
	});

	it("equal major, different minor/patch → still ok (major is the compatibility axis)", () => {
		assert.deepStrictEqual(decidePnpmVersionGuard(v("10.27.0", 10), v("10.30.1", 10)), {
			ok: true,
			resolved: v("10.30.1", 10),
		});
	});

	it("wrong major (pnpm@8 vs required 10) → fail-closed major-mismatch (the #3498 bug)", () => {
		assert.deepStrictEqual(decidePnpmVersionGuard(v("10.27.0", 10), v("8.15.6", 8)), {
			ok: false,
			reason: "major-mismatch",
			required: v("10.27.0", 10),
			resolved: v("8.15.6", 8),
		});
	});

	it("required unresolved → fail-closed unresolved-required", () => {
		assert.deepStrictEqual(decidePnpmVersionGuard(null, v("10.27.0", 10)), {
			ok: false,
			reason: "unresolved-required",
		});
	});

	it("pnpm probe unresolved (no corepack/pnpm) → fail-closed unresolved-pnpm", () => {
		assert.deepStrictEqual(decidePnpmVersionGuard(v("10.27.0", 10), null), {
			ok: false,
			reason: "unresolved-pnpm",
		});
	});

	it("both unresolved → fail-closed on the required side first", () => {
		assert.deepStrictEqual(decidePnpmVersionGuard(null, null), {
			ok: false,
			reason: "unresolved-required",
		});
	});
});
