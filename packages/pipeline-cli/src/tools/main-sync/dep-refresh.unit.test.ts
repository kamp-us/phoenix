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

describe("pathForcesDepRefresh — the lockfile + patches/ are dep inputs", () => {
	it("pnpm-lock.yaml forces a refresh", () => {
		assert.isTrue(pathForcesDepRefresh("pnpm-lock.yaml"));
	});

	it("any patches/** file forces a refresh (the #3498 patched-dep hazard)", () => {
		assert.isTrue(pathForcesDepRefresh("patches/effect@4.0.0-beta.92.patch"));
		assert.isTrue(pathForcesDepRefresh("patches/@nkzw__fate@1.3.1.patch"));
	});

	it("unrelated source/doc changes do NOT force a refresh", () => {
		assert.isFalse(pathForcesDepRefresh("apps/web/worker/index.ts"));
		assert.isFalse(pathForcesDepRefresh("README.md"));
		// a lookalike that is NOT the lockfile nor under patches/ is not a dep input
		assert.isFalse(pathForcesDepRefresh("docs/pnpm-lock.yaml.md"));
		assert.isFalse(pathForcesDepRefresh("patches-notes.md"));
	});
});

describe("depPathsForcingRefresh / changedPathsForceDepRefresh", () => {
	it("returns exactly the forcing subset, order-preserving", () => {
		const changed = [
			"apps/web/worker/index.ts",
			"patches/effect@4.0.0-beta.92.patch",
			"README.md",
			"pnpm-lock.yaml",
		];
		assert.deepStrictEqual(depPathsForcingRefresh(changed), [
			"patches/effect@4.0.0-beta.92.patch",
			"pnpm-lock.yaml",
		]);
		assert.isTrue(changedPathsForceDepRefresh(changed));
	});

	it("a merge with no dep-input change does not force a refresh", () => {
		const changed = ["apps/web/src/App.tsx", ".decisions/0200-foo.md"];
		assert.deepStrictEqual(depPathsForcingRefresh(changed), []);
		assert.isFalse(changedPathsForceDepRefresh(changed));
	});

	it("an empty diff (no files) does not force a refresh", () => {
		assert.isFalse(changedPathsForceDepRefresh([]));
	});
});

describe("parsePackageManagerPnpm — the packageManager pin", () => {
	it("parses `pnpm@10.27.0` to version + major", () => {
		assert.deepStrictEqual(parsePackageManagerPnpm("pnpm@10.27.0"), {
			version: "10.27.0",
			major: 10,
		});
	});

	it("absorbs a corepack integrity-hash suffix", () => {
		assert.deepStrictEqual(parsePackageManagerPnpm("pnpm@10.27.0+sha512.abc"), {
			version: "10.27.0",
			major: 10,
		});
	});

	it("returns null for a different package manager, absent, or malformed pin", () => {
		assert.isNull(parsePackageManagerPnpm("yarn@4.1.0"));
		assert.isNull(parsePackageManagerPnpm(undefined));
		assert.isNull(parsePackageManagerPnpm(""));
		assert.isNull(parsePackageManagerPnpm("pnpm"));
		assert.isNull(parsePackageManagerPnpm("pnpm@10"));
	});
});

describe("parsePnpmVersionOutput — `pnpm --version` stdout", () => {
	it("parses a bare semver line", () => {
		assert.deepStrictEqual(parsePnpmVersionOutput("10.27.0\n"), {version: "10.27.0", major: 10});
	});

	it("parses the wrong-major bare-PATH pnpm (8.15.6) — so the guard can reject it", () => {
		assert.deepStrictEqual(parsePnpmVersionOutput("8.15.6"), {version: "8.15.6", major: 8});
	});

	it("returns null for empty / non-semver output (corepack didn't resolve)", () => {
		assert.isNull(parsePnpmVersionOutput(""));
		assert.isNull(parsePnpmVersionOutput("   "));
		assert.isNull(parsePnpmVersionOutput("command not found"));
	});
});

describe("decidePnpmVersionGuard — candidate 3, folded into the install path", () => {
	const v = (version: string, major: number): PnpmVersion => ({version, major});

	it("matching major → ok (the install is authorized)", () => {
		const g = decidePnpmVersionGuard(v("10.27.0", 10), v("10.27.0", 10));
		assert.deepStrictEqual(g, {ok: true, resolved: v("10.27.0", 10)});
	});

	it("matching major with a differing patch/minor still passes (major is the guard axis)", () => {
		const g = decidePnpmVersionGuard(v("10.27.0", 10), v("10.28.1", 10));
		assert.isTrue(g.ok);
	});

	it("wrong major → fail-closed major-mismatch (the 8.x-vs-10.x #3498 case)", () => {
		const g = decidePnpmVersionGuard(v("10.27.0", 10), v("8.15.6", 8));
		assert.deepStrictEqual(g, {
			ok: false,
			reason: "major-mismatch",
			required: v("10.27.0", 10),
			resolved: v("8.15.6", 8),
		});
	});

	it("unparseable pin → fail-closed unresolved-required", () => {
		assert.deepStrictEqual(decidePnpmVersionGuard(null, v("10.27.0", 10)), {
			ok: false,
			reason: "unresolved-required",
		});
	});

	it("unresolved pnpm (corepack absent/errored) → fail-closed unresolved-pnpm, NEVER a bare-PATH fallback", () => {
		assert.deepStrictEqual(decidePnpmVersionGuard(v("10.27.0", 10), null), {
			ok: false,
			reason: "unresolved-pnpm",
		});
	});

	it("both null → unresolved-required (required is checked first)", () => {
		assert.deepStrictEqual(decidePnpmVersionGuard(null, null), {
			ok: false,
			reason: "unresolved-required",
		});
	});
});
