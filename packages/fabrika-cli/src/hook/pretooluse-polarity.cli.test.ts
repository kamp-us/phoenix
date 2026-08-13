/**
 * The polarity ADR 0250 rules, pinned as a test: a fabrika that cannot bootstrap must not block a
 * spawn.
 *
 * On `PreToolUse` exit `2` is the harness's one blocking code (`./harness-exit.ts`), and the
 * bootstrap/dispatch failures sat on it — so a fabrika install that could not resolve itself denied
 * every `Task`/`Workflow` spawn in the session, the exact inverse of the ruled fail-open (#5423).
 * Nothing in the type system stops that seat being taken again, so it is pinned in the two places it
 * can come back: the **exit code a real process returns**, and the **literals the bootstrap sources
 * carry**.
 *
 * The end-to-end leg runs the argv out of the committed `hooks.json` `PreToolUse` declaration rather
 * than a literal, for the same reason the golden test does: a pass must not be able to exercise a
 * verb the surface does not name. And it reaches a refusal for real rather than mocking one — a temp
 * directory made into a repo root that resolves a *different* `@kampus/fabrika-cli` is the
 * cross-checkout state, which triage found is the default in every crew worktree.
 *
 * `../delegate/foreign-checkout.cli.test.ts` spawns the same state and asserts a different property:
 * that the refusal happens at all, and that the cwd's install never answers. This file asserts what
 * the refusal costs a *hook* — that its exit code cannot deny the spawn the hook was consulted about.
 */

import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {readGoldenFixture} from "../golden-fixture.ts";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {NO_IMPLEMENTATION} from "../verb.ts";
import {argvOf, declaredHooks} from "./declaration.ts";
import {HARNESS_BUILD_READ, PRETOOLUSE_BLOCKING_EXIT} from "./harness-exit.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));
const HOOKS_JSON = "../../../../claude-plugins/fabrika/hooks.json";

/**
 * Every file that can end the process before a verb runs. The list is explicit because the claim is
 * about a closed set of sites, and a scan that silently covered fewer would be the vacuous pass
 * (ADR 0092) — the count is asserted below.
 */
const BOOTSTRAP_SOURCES = ["bin.ts", "delegate/entry.ts", "delegate/resolve.ts"] as const;

/** `process.exit(2)` or `status: 2` — the two shapes a bootstrap site ends the process with. */
const BLOCKING_EXIT_LITERAL = new RegExp(
	`(?:process\\.exit\\(\\s*${PRETOOLUSE_BLOCKING_EXIT}\\s*\\)|status:\\s*${PRETOOLUSE_BLOCKING_EXIT}\\b)`,
);

describe("no bootstrap or dispatch failure is seated on the harness's blocking code", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it(`reads the blocking code from the harness contract (Claude Code ${HARNESS_BUILD_READ})`, () => {
		expect(PRETOOLUSE_BLOCKING_EXIT).toBe(2);
		expect(NO_IMPLEMENTATION).not.toBe(PRETOOLUSE_BLOCKING_EXIT);
	});

	it("scans every bootstrap source, and a short scan is a failure rather than a pass", () => {
		const scanned = BOOTSTRAP_SOURCES.map((name) => readFileSync(join(SRC_DIR, name), "utf8"));
		expect(scanned).toHaveLength(BOOTSTRAP_SOURCES.length);
		for (const source of scanned) expect(source.length).toBeGreaterThan(0);
	});

	it.each(BOOTSTRAP_SOURCES)("%s ends the process on no literal blocking code", (name) => {
		const source = readFileSync(join(SRC_DIR, name), "utf8");
		expect(BLOCKING_EXIT_LITERAL.test(source)).toBe(false);
	});
});

/**
 * A repo root whose `@kampus/fabrika-cli` is a *different* copy from the one under test — the
 * cross-checkout state, manufactured rather than waited for. The installed manifest declares no
 * `exports`, so Node's own resolver answers its `package.json` the way a real install does.
 */
const foreignCheckout = (): string => {
	const root = mkdtempSync(join(tmpdir(), "fabrika-foreign-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({name: "foreign-checkout"}));
	const installed = join(root, "node_modules", "@kampus", "fabrika-cli");
	mkdirSync(installed, {recursive: true});
	writeFileSync(
		join(installed, "package.json"),
		JSON.stringify({
			name: "@kampus/fabrika-cli",
			version: "0.0.0-foreign",
			bin: {fabrika: "./bin.js"},
		}),
	);
	writeFileSync(join(installed, "bin.js"), "");
	return root;
};

describe("the PreToolUse hook the surface declares, run from a checkout it refuses to answer from", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	let root: string;
	beforeAll(() => {
		root = foreignCheckout();
	});
	afterAll(() => {
		rmSync(root, {recursive: true, force: true});
	});

	const declared = () => {
		const surface = declaredHooks(JSON.parse(readGoldenFixture(import.meta.url, HOOKS_JSON)));
		const hook = surface.find((row) => row.event === "PreToolUse");
		if (hook === undefined) throw new Error("hooks.json declares no PreToolUse hook");
		return hook;
	};

	const run = () => {
		// `FABRIKA_SKIP_INFER` is deleted rather than merely unset: it is the guard that skips the
		// delegation entirely, so inheriting one from the runner's shell would exercise nothing.
		const env: NodeJS.ProcessEnv = {...process.env};
		delete env.FABRIKA_SKIP_INFER;
		return spawnSync(process.execPath, [BIN, ...argvOf(declared().command)], {
			cwd: root,
			encoding: "utf8",
			env,
			input: "",
		});
	};

	it("refuses, and says so on stderr — fail open and loud, per ADR 0250", () => {
		expect(run().stderr).toContain("different checkouts");
	});

	it("does not exit on the blocking code, so the spawn proceeds", () => {
		const {status} = run();
		expect(status).not.toBe(PRETOOLUSE_BLOCKING_EXIT);
		expect(status).toBe(NO_IMPLEMENTATION);
	});
});
