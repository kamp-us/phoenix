/**
 * The end-to-end half of the `NODE_PATH` containment rule (#5768), spawned because the defect only
 * exists in a real process: `NODE_PATH` is baked into `Module.globalPaths` when a process loads, so
 * no in-test mutation reproduces it.
 *
 * The pnpm-generated global `fabrika` shim exports an absolute `NODE_PATH` chain rooted at the
 * checkout it was installed from. Standing in a repo with no install of its own, Node's walk fails
 * and that fallback answers instead — with the invoked copy itself, which used to read as "the
 * repo-local install is this copy" and silently swallow the global warning.
 */
import {spawnSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {NO_IMPLEMENTATION} from "../verb.ts";
import {GLOBAL_WARNING_DISABLED_ENV} from "./resolve.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const CHECKOUT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");

/** This checkout's own `node_modules`, i.e. the chain the real global shim exports. */
const SELF_NODE_MODULES = join(CHECKOUT, "node_modules");
const selfLinkInstalled = existsSync(
	join(SELF_NODE_MODULES, "@kampus", "fabrika-cli", "package.json"),
);

/** What a copy reachable only through `NODE_PATH` prints if it is ever allowed to answer. */
const IMPOSTER = "answered-from-the-NODE_PATH-copy";

let scratch: string;
/** A repo root with a manifest and no install at all — the shape the defect was reported against. */
let bare: string;
/** The same, but carrying its own install, so the foreign-checkout refusal has something to refuse. */
let installed: string;
/** A `@kampus/fabrika-cli` copy that lives in neither repo and is reachable only via `NODE_PATH`. */
let strayNodeModules: string;

const writeInstall = (nodeModules: string, marker: string) => {
	const pkg = join(nodeModules, "@kampus", "fabrika-cli");
	mkdirSync(pkg, {recursive: true});
	writeFileSync(join(pkg, "bin.js"), `console.log(${JSON.stringify(marker)});\n`);
	writeFileSync(
		join(pkg, "package.json"),
		'{"name":"@kampus/fabrika-cli","version":"9.9.9","bin":{"fabrika":"./bin.js"}}\n',
	);
};

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "fabrika-nodepath-"));
	bare = join(scratch, "bare");
	installed = join(scratch, "installed");
	strayNodeModules = join(scratch, "stray", "node_modules");
	mkdirSync(bare, {recursive: true});
	mkdirSync(installed, {recursive: true});
	writeFileSync(join(bare, "package.json"), '{"name":"bare","version":"0.0.0"}\n');
	writeFileSync(join(installed, "package.json"), '{"name":"installed","version":"0.0.0"}\n');
	writeInstall(join(installed, "node_modules"), "answered-from-the-cwd-checkout");
	writeInstall(strayNodeModules, IMPOSTER);
});

afterAll(() => rmSync(scratch, {recursive: true, force: true}));

/**
 * `spawnSync`, not `execFileSync`: the subject here is a **stderr warning on an exit-0 run**, and
 * `execFileSync` hands stderr back only on the throwing path.
 */
const invoke = (cwd: string, nodePath: string, ...args: ReadonlyArray<string>) => {
	const env: Record<string, string | undefined> = {...process.env, NODE_PATH: nodePath};
	delete env[GLOBAL_WARNING_DISABLED_ENV];
	const run = spawnSync(process.execPath, [BIN, ...args], {
		cwd,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {code: run.status ?? -1, stdout: run.stdout ?? "", stderr: run.stderr ?? ""};
};

describe("invoking this checkout's bin under a NODE_PATH that reaches a @kampus/fabrika-cli copy", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
	// The bin's own delegation is what is under test, so the guard that pins an invocation to this
	// copy has to stay unset — and vitest inherits the parent env.
	skip: process.env.FABRIKA_SKIP_INFER !== undefined,
}, () => {
	// The exact shim shape: the chain points back at the invoked copy, so before the containment rule
	// the probe found `selfPackageRoot` and `resolve` answered `run-here`, silently. It needs this
	// checkout to actually be installed; an uninstalled tree is a missing fixture, not a pass.
	it.skipIf(!selfLinkInstalled)("warns loudly in a repo with no install of its own", () => {
		const run = invoke(bare, SELF_NODE_MODULES, "--version");
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("fabrika v");
		expect(run.stderr).toContain("running the GLOBAL install");
		expect(run.stderr).toContain("has no local install");
	});

	it("warns just the same when the reachable copy is a stray third one, and never runs it", () => {
		const run = invoke(bare, strayNodeModules, "--version");
		expect(run.stdout).not.toContain(IMPOSTER);
		expect(run.code).toBe(0);
		expect(run.stderr).toContain("has no local install");
	});

	it("leaves the foreign-checkout refusal alone — the repo's own walk outranks the fallback", () => {
		const run = invoke(installed, strayNodeModules, "--version");
		expect(run.code).toBe(NO_IMPLEMENTATION);
		expect(run.stderr).toContain("different repositories");
		expect(run.stdout).not.toContain(IMPOSTER);
	});
});
