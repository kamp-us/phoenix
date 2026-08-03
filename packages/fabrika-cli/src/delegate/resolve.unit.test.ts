import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {faultingShell} from "../fakes.test-support.ts";
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
	it("recovers the signal name effect v4 only reports inside a message", () => {
		expect(signalFromError("Process interrupted due to receipt of signal: 'SIGINT'")).toBe(
			"SIGINT",
		);
	});

	it("answers undefined for a spawn fault — which must never read as a signal death", () => {
		expect(signalFromError("spawn node ENOENT")).toBeUndefined();
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
});
