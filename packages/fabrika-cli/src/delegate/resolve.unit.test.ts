import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect, PlatformError} from "effect";
import {describe, expect, it} from "vitest";
import {faultingShell, signalledExitError, signalledShell} from "../fakes.test-support.ts";
import type {LocalInstall} from "./local.ts";
import {
	GLOBAL_WARNING_DISABLED_ENV,
	globalWarning,
	resolve,
	signalFromError,
	spawnDelegate,
	traceLine,
} from "./resolve.ts";

const install: LocalInstall = {
	packageRoot: "/repo/packages/fabrika-cli",
	manifestPath: "/repo/node_modules/@kampus/fabrika-cli/package.json",
	binPath: "/repo/packages/fabrika-cli/src/bin.ts",
	version: "0.1.0",
};

const GLOBAL = "/usr/local/pnpm/global/5/node_modules/@kampus/fabrika-cli";

describe("resolve", () => {
	it("delegates to the repo-local install — the pinned version wins over the global", () => {
		expect(
			resolve({selfPackageRoot: GLOBAL, repoRoot: "/repo", local: {_tag: "found", install}}),
		).toEqual({_tag: "delegate", to: install});
	});

	it("runs here SILENTLY outside any repo — a global-only invocation is not a defect", () => {
		const resolution = resolve({selfPackageRoot: GLOBAL, repoRoot: undefined, local: undefined});
		expect(resolution._tag).toBe("run-here");
	});

	it("WARNS when a repo root exists but nothing is installed — the quietly-wrong case", () => {
		const resolution = resolve({
			selfPackageRoot: GLOBAL,
			repoRoot: "/repo",
			local: {_tag: "absent"},
		});
		expect(resolution._tag).toBe("warn-and-run-here");
	});

	it("warns rather than throws on a corrupt local — the worst outcome is running the global", () => {
		const resolution = resolve({
			selfPackageRoot: GLOBAL,
			repoRoot: "/repo",
			local: {_tag: "corrupt", reason: "manifest declares no version"},
		});
		expect(resolution).toEqual({
			_tag: "warn-and-run-here",
			repoRoot: "/repo",
			reason: "manifest declares no version",
		});
	});

	it("runs here when the install it found IS this copy, rather than spawning itself", () => {
		const resolution = resolve({
			selfPackageRoot: install.packageRoot,
			repoRoot: "/repo",
			local: {_tag: "found", install},
		});
		expect(resolution._tag).toBe("run-here");
	});
});

describe("globalWarning", () => {
	it("names BOTH versions — the global's and the one the repo declared", () => {
		const text = globalWarning({
			repoRoot: "/repo",
			reason: "it has no local install",
			globalVersion: "0.1.0",
			declared: "^0.4.0",
		});
		expect(text).toContain("v0.1.0");
		expect(text).toContain("^0.4.0");
		expect(text).toContain(GLOBAL_WARNING_DISABLED_ENV);
	});

	it("says so plainly when the repo declares no dependency at all", () => {
		const text = globalWarning({
			repoRoot: "/repo",
			reason: "it has no local install",
			globalVersion: "0.1.0",
			declared: undefined,
		});
		expect(text).toContain("declares no @kampus/fabrika-cli dependency");
	});
});

describe("traceLine", () => {
	it("names both copies on a delegation, so the hop is checkable from outside", () => {
		const line = traceLine(
			GLOBAL,
			resolve({selfPackageRoot: GLOBAL, repoRoot: "/repo", local: {_tag: "found", install}}),
		);
		expect(line).toContain(GLOBAL);
		expect(line).toContain(install.packageRoot);
		expect(line).toContain(install.binPath);
	});

	it("says why it stayed put, not merely that it did", () => {
		const line = traceLine(
			GLOBAL,
			resolve({selfPackageRoot: GLOBAL, repoRoot: undefined, local: undefined}),
		);
		expect(line).toContain("not inside a repo");
	});
});

describe("signalFromError", () => {
	/**
	 * The regression test that matters: the operand is the error the spawner really fails with, not a
	 * literal the caller never supplies. Reading `.message` — the shape this once had — sees only
	 * `Unknown: ChildProcess.exitCode (…)`, so the assertion pair below fails the pre-fix code.
	 */
	it("reads the signal out of the nested cause of a real spawner PlatformError", () => {
		const error = signalledExitError("SIGINT", `/usr/bin/node ${install.binPath} --skip-infer adr`);
		expect(error.message).not.toContain("SIGINT");
		expect(signalFromError(error)).toBe("SIGINT");
	});

	it("answers undefined for a spawn fault — which must never read as a signal death", () => {
		expect(
			signalFromError(
				PlatformError.badArgument({
					module: "ChildProcess",
					method: "spawn",
					description: "spawn node ENOENT",
				}),
			),
		).toBeUndefined();
	});
});

describe("spawnDelegate", () => {
	it("answers 2 — not the child's verdict — when the spawn itself faults", async () => {
		const outcome = await Effect.runPromise(
			spawnDelegate({
				execPath: "/usr/bin/node",
				binPath: install.binPath,
				args: ["adr", "next"],
				cwd: "/repo",
				invocationDir: "/repo/packages/fabrika-cli",
			}).pipe(Effect.provide(faultingShell)),
		);
		expect(outcome).toEqual({_tag: "exited", status: 2});
	});

	it("reports a signal-killed child as signalled, never as the exit-2 could-not-run diagnosis", async () => {
		const outcome = await Effect.runPromise(
			spawnDelegate({
				execPath: "/usr/bin/node",
				binPath: install.binPath,
				args: ["adr", "next"],
				cwd: "/repo",
				invocationDir: "/repo/packages/fabrika-cli",
			}).pipe(Effect.provide(signalledShell("SIGINT"))),
		);
		expect(outcome).toEqual({_tag: "signalled", signal: "SIGINT"});
	});

	/**
	 * The end-to-end anchor: a genuinely signalled child through the REAL spawner, so the fix stays
	 * bound to the dependency's actual error shape rather than to our reproduction of it.
	 */
	it("reports a genuinely SIGINT-killed child, spawned through the real platform spawner", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fabrika-signal-"));
		const child = join(dir, "kills-itself.js");
		writeFileSync(child, "process.kill(process.pid, 'SIGINT');\nsetTimeout(() => {}, 5000);\n");
		try {
			const outcome = await Effect.runPromise(
				spawnDelegate({
					execPath: process.execPath,
					binPath: child,
					args: [],
					cwd: dir,
					invocationDir: dir,
				}).pipe(Effect.provide(NodeServices.layer)),
			);
			expect(outcome).toEqual({_tag: "signalled", signal: "SIGINT"});
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	});
});
