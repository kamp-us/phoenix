/**
 * `resolveRealGh` / `resolveRepo` over a fake PATH/FS — the capability-seam test
 * (#855). The self-recursion guard + PATH fallbacks are crossed here against a
 * real temp dir of fake `gh` binaries (the fake FS seam), never by spawning the
 * shim: a `gh` on PATH whose realpath equals `self` is skipped, a distinct real
 * `gh` is chosen, an explicit `$GH_PHOENIX_REAL_GH` short-circuits, and a
 * no-real-`gh` PATH resolves to null ("can't passthrough").
 */
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {delimiter, join} from "node:path";
import {afterAll, afterEach, assert, beforeAll, describe, it} from "@effect/vitest";
import {resolveRealGh, resolveRepo} from "./resolve.ts";

let root: string;
const ENV_KEYS = ["PATH", "GH_PHOENIX_REAL_GH", "CLAUDE_PIPELINE_REPO"] as const;
let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;

const mkExecutable = (dir: string, name = "gh"): string => {
	mkdirSync(dir, {recursive: true});
	const p = join(dir, name);
	writeFileSync(p, "#!/usr/bin/env bash\necho fake\n", "utf8");
	chmodSync(p, 0o755);
	return realpathSync(p);
};

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "gh-phoenix-resolve-"));
});
afterAll(() => {
	rmSync(root, {recursive: true, force: true});
});
afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved?.[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

const setEnv = (env: Partial<Record<(typeof ENV_KEYS)[number], string>>) => {
	saved = {PATH: undefined, GH_PHOENIX_REAL_GH: undefined, CLAUDE_PIPELINE_REPO: undefined};
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	for (const key of ENV_KEYS) {
		const value = env[key];
		if (value !== undefined) process.env[key] = value;
	}
};

describe("resolveRealGh — self-recursion guard + PATH fallbacks over a fake FS", () => {
	it("skips a PATH `gh` that resolves to `self` and picks the next, distinct real `gh`", () => {
		const dir = mkdtempSync(join(root, "case-skip-"));
		// `self` is the shim's own path; a symlinked `gh` in shimDir realpaths to it.
		const self = mkExecutable(join(dir, "shim"), "gh-phoenix");
		const shimDir = join(dir, "shim-on-path");
		mkdirSync(shimDir, {recursive: true});
		symlinkSync(self, join(shimDir, "gh"));
		const realDir = join(dir, "real");
		const realGh = mkExecutable(realDir);

		setEnv({PATH: `${shimDir}${delimiter}${realDir}`});
		// shimDir/gh realpaths to `self` → skipped; realDir/gh is chosen (returned
		// verbatim, so realpath it to compare past macOS's /var → /private/var).
		const resolved = resolveRealGh(self);
		assert.isNotNull(resolved);
		assert.strictEqual(resolved && realpathSync(resolved), realGh);
	});

	it("returns null when the ONLY `gh` on PATH is the shim itself (can't passthrough)", () => {
		const dir = mkdtempSync(join(root, "case-only-self-"));
		const self = mkExecutable(join(dir, "shim"), "gh-phoenix");
		const shimDir = join(dir, "shim-on-path");
		mkdirSync(shimDir, {recursive: true});
		symlinkSync(self, join(shimDir, "gh"));

		setEnv({PATH: shimDir});
		assert.strictEqual(resolveRealGh(self), null);
	});

	it("returns null when no `gh` exists anywhere on PATH", () => {
		const dir = mkdtempSync(join(root, "case-none-"));
		const empty = join(dir, "empty");
		mkdirSync(empty, {recursive: true});
		setEnv({PATH: empty});
		assert.strictEqual(resolveRealGh("/nonexistent/self"), null);
	});

	it("an explicit, executable $GH_PHOENIX_REAL_GH short-circuits PATH resolution", () => {
		const dir = mkdtempSync(join(root, "case-explicit-"));
		const explicit = mkExecutable(join(dir, "explicit"));
		// PATH also has a `gh`, but the explicit override wins without consulting it.
		const pathGh = mkExecutable(join(dir, "path"));
		setEnv({GH_PHOENIX_REAL_GH: explicit, PATH: join(dir, "path")});
		// The explicit env value is returned verbatim — it is the realpath'd `explicit`.
		assert.strictEqual(resolveRealGh("/nonexistent/self"), explicit);
		assert.notStrictEqual(explicit, pathGh);
	});

	it("ignores a non-executable $GH_PHOENIX_REAL_GH and falls back to PATH", () => {
		const dir = mkdtempSync(join(root, "case-nonexec-"));
		const notExec = join(dir, "not-exec");
		writeFileSync(notExec, "plain file, not +x", "utf8");
		const realGh = mkExecutable(join(dir, "path"));
		setEnv({GH_PHOENIX_REAL_GH: notExec, PATH: join(dir, "path")});
		const resolved = resolveRealGh("/nonexistent/self");
		assert.isNotNull(resolved);
		// resolveRealGh returns the `$PATH`/gh candidate verbatim; realpath it to compare
		// (macOS /var → /private/var) against the realpath'd fake gh.
		assert.strictEqual(resolved && realpathSync(resolved), realGh);
	});
});

describe("resolveRepo — env override + no-real-`gh` fallback", () => {
	it("$CLAUDE_PIPELINE_REPO wins, never shelling `gh repo view`", () => {
		setEnv({CLAUDE_PIPELINE_REPO: "owner/repo"});
		assert.strictEqual(resolveRepo(null), "owner/repo");
	});

	it("falls back to the phoenix default when no env and no real `gh`", () => {
		setEnv({});
		assert.strictEqual(resolveRepo(null), "kamp-us/phoenix");
	});
});
