/**
 * The pin→dispatch chain: what `guard.sh` actually exec's is the pinned build, and the pinned
 * build carries ADR 0172's isolation guard (#3742).
 *
 * `guard.sh` used to gate readiness on `[ -x "$BIN" ]`. Because `0.2.0` was never published,
 * every SessionStart install failed and the wrapper kept exec'ing the stale `0.1.0` tree — a
 * build predating ADR 0172 with zero copies of `isIsolationExpected` — while reporting itself
 * ready. Nothing observable distinguished "the isolation guard is enforcing" from "the isolation
 * guard has not shipped." These tests are that missing observation, wired blocking: they drive
 * the REAL script against throwaway data dirs (the create-worktree.hook.test.ts idiom), and they
 * assert the four links of the chain end to end — hook pin == package.json version == the CLI's
 * own `VERSION`, dispatch only on a matching marker, and `isIsolationExpected` present in the
 * source that version publishes.
 *
 * Coverage note: the hook scripts are inside CI's `packages` path filter, so a `hooks/**` edit
 * runs this suite (ADR 0180 / the #2925 gap).
 */
import {execFileSync, spawnSync} from "node:child_process";
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, assert, describe, it} from "@effect/vitest";
import {VERSION} from "./version.ts";

const repoPath = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

const HOOKS = "claude-plugins/kampus-pipeline/hooks";
const GUARD_SH = repoPath(`${HOOKS}/guard.sh`);
const PIN_SH = repoPath(`${HOOKS}/pin.sh`);

/** The pin as the hooks themselves read it — sourced, never regex-scraped out of the file. */
const hookPin = (): string =>
	execFileSync("bash", ["-c", `. "${PIN_SH}"; printf '%s' "$KAMPUS_PIPELINE_CLI_PIN"`], {
		encoding: "utf8",
	});

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * A throwaway pipeline data dir holding a stub `pipeline-cli` that echoes its argv, so
 * "did guard.sh dispatch?" is answerable from stdout alone. `marker` is the version
 * install.sh would have attested; `null` is the dropped-marker state a failed install leaves.
 */
const dataDirWith = (args: {readonly marker: string | null}): string => {
	const data = mkdtempSync(join(tmpdir(), "pipeline-data-"));
	const bin = join(data, "node_modules", ".bin", "pipeline-cli");
	mkdirSync(dirname(bin), {recursive: true});
	writeFileSync(bin, '#!/usr/bin/env bash\necho "DISPATCHED $*"\n');
	chmodSync(bin, 0o755);
	if (args.marker !== null) writeFileSync(join(data, ".pipeline-cli.version"), args.marker);
	return data;
};

// spawnSync, not execFileSync: a refusal exits 0, so its stderr is only observable on the
// success path — and the loud-refusal contract is precisely what these tests assert.
const runGuard = (data: string, ...argv: string[]): RunResult => {
	const r = spawnSync("bash", [GUARD_SH, ...argv], {
		encoding: "utf8",
		input: "",
		env: {...process.env, KAMPUS_PIPELINE_DATA: data},
	});
	return {code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? ""};
};

describe("guard.sh readiness is a VERSION check, not an executability check (#3742)", () => {
	const dirs: string[] = [];
	const dataDir = (marker: string | null) => {
		const d = dataDirWith({marker});
		dirs.push(d);
		return d;
	};
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});
	});

	it("dispatches when the installed marker matches the pin", () => {
		const {code, stdout} = runGuard(dataDir(hookPin()), "worktree-guard", "pre-file");
		assert.strictEqual(code, 0);
		assert.strictEqual(
			stdout.trim(),
			"DISPATCHED worktree-guard pre-file",
			"a pinned install must dispatch, forwarding argv unchanged",
		);
	});

	// THE #3742 REPRODUCTION. Executable stale bin + a version that is not the pin: the old
	// `[ -x "$BIN" ]` readiness test dispatches this happily, which is how a pre-ADR-0172 build
	// ran the isolation guards for months.
	it("REFUSES to dispatch a stale build whose version is not the pin", () => {
		const {code, stdout, stderr} = runGuard(dataDir("0.1.0"), "worktree-guard", "pre-file");
		assert.notInclude(stdout, "DISPATCHED", "a non-pinned build must never be exec'd");
		assert.strictEqual(
			code,
			0,
			"the refusal still fail-opens (#1050) — it must not abort the hook",
		);
		assert.include(stderr, "0.1.0", "the warning must name the installed version");
		assert.include(stderr, hookPin(), "the warning must name the pinned version");
		assert.include(stderr, "#3742");
	});

	// The live state this issue was filed from: install failed, so install.sh dropped the marker,
	// but the stale tree it could not overwrite is still on disk and still executable.
	it("REFUSES to dispatch when the marker is absent (a failed install left the tree behind)", () => {
		const {code, stdout, stderr} = runGuard(dataDir(null), "spawn-guard", "guard");
		assert.notInclude(stdout, "DISPATCHED");
		assert.strictEqual(code, 0);
		assert.include(
			stderr,
			"none",
			"an absent marker must be reported as an installed version of none",
		);
	});

	it("warns once per drift state, then stays quiet — the pre-file hook fires on every file tool", () => {
		const data = dataDir("0.1.0");
		const first = runGuard(data, "worktree-guard", "pre-file");
		const second = runGuard(data, "worktree-guard", "pre-file");
		assert.notStrictEqual(first.stderr.trim(), "", "the first refusal must be loud");
		assert.strictEqual(
			second.stderr.trim(),
			"",
			"subsequent refusals must not spam the transcript",
		);
	});

	it("still fail-opens silently when no CLI is installed at all (#1050, unchanged)", () => {
		const empty = mkdtempSync(join(tmpdir(), "pipeline-empty-"));
		dirs.push(empty);
		const {code, stdout, stderr} = runGuard(empty, "worktree-guard", "pre-file");
		assert.strictEqual(code, 0);
		assert.strictEqual(stdout.trim(), "");
		assert.strictEqual(stderr.trim(), "", "a cold consumer is the expected state, not a fault");
	});
});

describe("the dispatched build carries ADR 0172's isolation guard (#3742 AC3)", () => {
	// Links 1–2 of the chain: the version guard.sh admits is the version this workspace builds
	// and publishes. Without this a pin bump could point at a version whose source is something
	// else entirely, and the marker comparison would attest nothing.
	it("the hook pin, the package version, and the CLI's own VERSION are one version", () => {
		const pkg = JSON.parse(
			readFileSync(repoPath("packages/pipeline-cli/package.json"), "utf8"),
		) as {version: string};
		assert.strictEqual(hookPin(), pkg.version, `${HOOKS}/pin.sh must pin this package's version`);
		assert.strictEqual(VERSION, pkg.version, "src/version.ts must not misreport what shipped");
	});

	// Link 3: that version's source carries the guard. The stale 0.1.0 tarball has zero
	// occurrences of this symbol, which is the whole reason ADR 0172 was inert in the shipped
	// build — so its presence is the property worth asserting mechanically, not assuming.
	it("the pinned source exports isIsolationExpected", () => {
		const src = readFileSync(
			repoPath("packages/pipeline-cli/src/tools/worktree-guard/bash-pin.ts"),
			"utf8",
		);
		assert.include(src, "export const isIsolationExpected");
	});
});
