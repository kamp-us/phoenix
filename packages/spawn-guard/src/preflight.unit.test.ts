import {execFile} from "node:child_process";
import {copyFileSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {
	degradedGuardDeny,
	degradedStatusline,
	depsInstalled,
	freshnessSignal,
	RUNTIME_DEP,
} from "./preflight.ts";

describe("preflight — runtime-dep probe + degraded outputs (#777)", () => {
	it("resolves the real runtime dep as installed", () => {
		assert.isTrue(depsInstalled(RUNTIME_DEP));
	});
	it("reports a non-existent package as NOT installed", () => {
		assert.isFalse(depsInstalled("@kampus/this-does-not-exist-777"));
	});
	it("never throws on a bogus specifier", () => {
		assert.doesNotThrow(() => depsInstalled("totally-bogus"));
	});

	it("degraded guard output is a fail-CLOSED deny that names the dep (ADR 0092)", () => {
		const out = JSON.parse(degradedGuardDeny());
		assert.strictEqual(out.hookSpecificOutput.permissionDecision, "deny");
		assert.include(out.hookSpecificOutput.permissionDecisionReason, RUNTIME_DEP);
		assert.include(out.hookSpecificOutput.permissionDecisionReason, "pnpm install");
	});

	it("degraded statusline is a non-empty visible placeholder (never blank, #758)", () => {
		assert.isTrue(degradedStatusline().trim().length > 0);
	});

	it("freshness signal is null when deps resolve — a fresh tree gets no output (#835)", () => {
		assert.isNull(freshnessSignal(RUNTIME_DEP));
	});

	it("freshness signal names the dep + `pnpm install` when deps are missing (#835)", () => {
		const signal = freshnessSignal("@kampus/this-does-not-exist-835");
		assert.isNotNull(signal);
		assert.include(signal ?? "", "@kampus/this-does-not-exist-835");
		assert.include(signal ?? "", "pnpm install");
	});
});

const SRC = dirname(fileURLToPath(new URL("./bin.ts", import.meta.url)));

const runIsolated = (
	isoBin: string,
	args: ReadonlyArray<string>,
	stdin: string,
): Promise<{code: number; stdout: string; stderr: string}> =>
	new Promise((resolve) => {
		const {NODE_PATH: _drop, ...env} = process.env;
		const child = execFile("node", [isoBin, ...args], {env}, (error, stdout, stderr) => {
			const code =
				error && typeof (error as {code?: unknown}).code === "number"
					? (error as {code: number}).code
					: 0;
			resolve({code, stdout, stderr});
		});
		child.stdin?.end(stdin);
	});

// On a tree where @effect/platform-node is NOT resolvable, the bin degrades per
// subcommand and never throws an unhandled module-load error.
describe("bin — missing-dep degradation over the real entrypoint (#777)", () => {
	let isoDir: string;
	beforeAll(() => {
		isoDir = mkdtempSync(join(tmpdir(), "spawn-guard-nodeps-"));
		// Only the builtin-only modules — bin.run.ts (the platform-node importer) is omitted;
		// the preflight short-circuits before it would be dynamically imported.
		for (const f of ["bin.ts", "preflight.ts", "spawn-guard.ts"]) {
			copyFileSync(join(SRC, f), join(isoDir, f));
		}
	});
	afterAll(() => rmSync(isoDir, {recursive: true, force: true}));

	it("guard fails CLOSED (deny) with a loud stderr note", async () => {
		const {code, stdout, stderr} = await runIsolated(
			join(isoDir, "bin.ts"),
			["guard"],
			JSON.stringify({tool_input: {model: "claude-opus-4-8"}}),
		);
		assert.strictEqual(code, 0);
		assert.strictEqual(JSON.parse(stdout).hookSpecificOutput.permissionDecision, "deny");
		assert.include(stderr, "@effect/platform-node");
		assert.include(stderr, "pnpm install");
	}, 30_000);

	it("statusline prints a visible placeholder, never blank (#758)", async () => {
		const {code, stdout, stderr} = await runIsolated(join(isoDir, "bin.ts"), ["statusline"], "{}");
		assert.strictEqual(code, 0);
		assert.isTrue(stdout.trim().length > 0);
		assert.include(stderr, "@effect/platform-node");
	}, 30_000);

	it("an unknown/no subcommand exits non-zero with the stderr note (can't run)", async () => {
		const {code, stderr} = await runIsolated(join(isoDir, "bin.ts"), [], "{}");
		assert.notStrictEqual(code, 0);
		assert.include(stderr, "@effect/platform-node");
	}, 30_000);
});

// On a stale tree the SessionStart freshness bin (#835) emits a SessionStart
// additionalContext signal + a loud stderr note + exit 2 — the proactive up-front flag.
describe("freshness-bin — SessionStart stale-tree signal over the real entrypoint (#835)", () => {
	let isoDir: string;
	beforeAll(() => {
		isoDir = mkdtempSync(join(tmpdir(), "spawn-guard-fresh-"));
		for (const f of ["freshness-bin.ts", "preflight.ts"]) {
			copyFileSync(join(SRC, f), join(isoDir, f));
		}
	});
	afterAll(() => rmSync(isoDir, {recursive: true, force: true}));

	it("emits a SessionStart additionalContext + stderr note + exit 2 on a stale tree", async () => {
		const {code, stdout, stderr} = await runIsolated(join(isoDir, "freshness-bin.ts"), [], "");
		assert.strictEqual(code, 2);
		const out = JSON.parse(stdout);
		assert.strictEqual(out.hookSpecificOutput.hookEventName, "SessionStart");
		assert.include(out.hookSpecificOutput.additionalContext, "pnpm install");
		assert.include(stderr, "pnpm install");
	}, 30_000);
});
