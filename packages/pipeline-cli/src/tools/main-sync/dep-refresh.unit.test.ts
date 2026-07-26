import {assert, describe, it} from "@effect/vitest";
import {
	changedPathsForceDepRefresh,
	classifyPathPnpm,
	decidePnpmResolution,
	decidePnpmVersionGuard,
	depPathsForcingRefresh,
	describePnpmResolutionFailure,
	type PnpmProbeResult,
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

const v = (version: string, major: number): PnpmVersion => ({version, major});
const PIN = v("10.27.0", 10);
const ran = (version: PnpmVersion): PnpmProbeResult => ({ran: true, version});
const failed: PnpmProbeResult = {ran: false, cause: "probe-failed"};
const unparseable: PnpmProbeResult = {ran: false, cause: "unparseable-output"};

describe("classifyPathPnpm — three outcomes, and 'could not run' is never 'wrong version'", () => {
	it("PATH pnpm exactly equal to the pin → exact-match", () => {
		assert.deepStrictEqual(classifyPathPnpm(PIN, ran(v("10.27.0", 10))), {
			kind: "exact-match",
			version: v("10.27.0", 10),
		});
	});

	it("same major, different patch → version-mismatch (exact equality, NOT the corepack leg's major rule)", () => {
		assert.deepStrictEqual(classifyPathPnpm(PIN, ran(v("10.28.1", 10))), {
			kind: "version-mismatch",
			required: PIN,
			found: v("10.28.1", 10),
		});
	});

	it("wrong major → version-mismatch (the #3498 hazard stays closed)", () => {
		const verdict = classifyPathPnpm(PIN, ran(v("8.15.6", 8)));
		assert.strictEqual(verdict.kind, "version-mismatch");
	});

	it("an unrunnable probe is UNDETERMINED, not a mismatch (absent binary / stripped PATH / timeout)", () => {
		assert.deepStrictEqual(classifyPathPnpm(PIN, failed), {
			kind: "undetermined",
			cause: "probe-failed",
		});
	});

	it("output that parsed to nothing is undetermined too — it observed no version", () => {
		assert.deepStrictEqual(classifyPathPnpm(PIN, unparseable), {
			kind: "undetermined",
			cause: "unparseable-output",
		});
	});

	it("no pin → undetermined; a PATH pnpm can't be checked against nothing", () => {
		assert.deepStrictEqual(classifyPathPnpm(null, ran(v("10.27.0", 10))), {
			kind: "undetermined",
			cause: "no-required-version",
		});
	});
});

describe("decidePnpmResolution — PATH-exact, else corepack, else fail closed", () => {
	const neverProbed = (): PnpmProbeResult => {
		throw new Error("corepack must not be probed");
	};

	it("an exactly-pinned PATH pnpm authorizes the install and corepack is never probed", () => {
		assert.deepStrictEqual(decidePnpmResolution(PIN, ran(v("10.27.0", 10)), neverProbed), {
			ok: true,
			resolver: "path",
			resolved: v("10.27.0", 10),
		});
	});

	it("corepack-less machine + exactly-pinned PATH pnpm → ok (the #4063 volta case)", () => {
		const r = decidePnpmResolution(PIN, ran(v("10.27.0", 10)), () => failed);
		assert.deepStrictEqual(r, {ok: true, resolver: "path", resolved: v("10.27.0", 10)});
	});

	it("no PATH pnpm → falls back to corepack, which authorizes on a matching major", () => {
		assert.deepStrictEqual(
			decidePnpmResolution(PIN, failed, () => ran(v("10.28.1", 10))),
			{
				ok: true,
				resolver: "corepack",
				resolved: v("10.28.1", 10),
			},
		);
	});

	it("a NON-exact PATH pnpm is never used for the install — the fallback still runs", () => {
		const r = decidePnpmResolution(PIN, ran(v("8.15.6", 8)), () => ran(v("10.27.0", 10)));
		assert.deepStrictEqual(r, {ok: true, resolver: "corepack", resolved: v("10.27.0", 10)});
	});

	it("a wrong-version PATH pnpm with no corepack → fail closed, carrying BOTH legs' reasons", () => {
		const r = decidePnpmResolution(PIN, ran(v("8.15.6", 8)), () => failed);
		assert.deepStrictEqual(r, {
			ok: false,
			required: PIN,
			path: {kind: "version-mismatch", required: PIN, found: v("8.15.6", 8)},
			corepack: {ok: false, reason: "unresolved-pnpm"},
		});
	});

	it("neither resolver runs → fail closed, with the PATH leg reported as UNDETERMINED", () => {
		const r = decidePnpmResolution(PIN, failed, () => failed);
		assert.deepStrictEqual(r, {
			ok: false,
			required: PIN,
			path: {kind: "undetermined", cause: "probe-failed"},
			corepack: {ok: false, reason: "unresolved-pnpm"},
		});
	});

	it("corepack resolves the wrong major → fail closed on major-mismatch", () => {
		const r = decidePnpmResolution(PIN, failed, () => ran(v("8.15.6", 8)));
		assert.isFalse(r.ok);
		assert.deepStrictEqual(r.ok === false && r.corepack, {
			ok: false,
			reason: "major-mismatch",
			required: PIN,
			resolved: v("8.15.6", 8),
		});
	});

	it("no pin → fail closed without probing corepack at all", () => {
		assert.deepStrictEqual(decidePnpmResolution(null, ran(v("10.27.0", 10)), neverProbed), {
			ok: false,
			required: null,
			path: {kind: "undetermined", cause: "no-required-version"},
			corepack: {ok: false, reason: "unresolved-required"},
		});
	});
});

describe("describePnpmResolutionFailure — a remedy the machine can actually run", () => {
	const failureOf = (path: PnpmProbeResult, corepack: () => PnpmProbeResult) => {
		const r = decidePnpmResolution(PIN, path, corepack);
		assert.isFalse(r.ok);
		if (r.ok) throw new Error("unreachable");
		return describePnpmResolutionFailure(r);
	};

	it("no corepack anywhere → the remedy never tells the operator to run corepack", () => {
		const {detail, remedy} = failureOf(failed, () => failed);
		assert.notInclude(remedy, "corepack pnpm@");
		assert.include(remedy, "install pnpm@10.27.0");
		assert.include(detail, "UNKNOWN");
	});

	it("a verified-wrong PATH pnpm is reported as wrong, and its remedy uses the pnpm that exists", () => {
		const {detail, remedy} = failureOf(ran(v("8.15.6", 8)), () => failed);
		assert.include(detail, "8.15.6");
		assert.include(detail, "NOT the pinned 10.27.0");
		assert.include(remedy, "pnpm dlx pnpm@10.27.0 install --frozen-lockfile");
	});

	it("an undetermined PATH is never described as a wrong version", () => {
		const {detail} = failureOf(failed, () => failed);
		assert.notInclude(detail, "NOT the pinned");
		assert.include(detail, "not wrong");
	});

	it("an unparseable pin routes to the fix-the-pin remedy", () => {
		const r = decidePnpmResolution(null, failed, () => failed);
		assert.isFalse(r.ok);
		if (r.ok) throw new Error("unreachable");
		assert.include(describePnpmResolutionFailure(r).remedy, "packageManager");
	});
});
