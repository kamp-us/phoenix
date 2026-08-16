/**
 * The end-to-end half of the foreign-checkout refusal: a real process, invoked exactly the way the
 * defect was met (#4956).
 *
 * A reviewer gating a PR runs from an isolated worktree and invokes the head's `bin.ts` **by path**.
 * The cwd then sits in a different checkout, whose own install answers instead — silently, with a
 * plausible result. The unit tests decide the branch; only a spawn proves the copy on disk obeys it,
 * because the delegation's whole failure mode is that both copies print the same bytes.
 */
import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {NO_IMPLEMENTATION} from "../verb.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));

/** What the other checkout's install prints if it is ever allowed to answer. */
const IMPOSTER = "answered-from-the-cwd-checkout";

let consumer: string;

beforeAll(() => {
	consumer = mkdtempSync(join(tmpdir(), "fabrika-foreign-"));
	const installed = join(consumer, "node_modules", "@kampus", "fabrika-cli");
	mkdirSync(installed, {recursive: true});
	writeFileSync(join(consumer, "package.json"), '{"name":"consumer","version":"0.0.0"}\n');
	writeFileSync(join(installed, "bin.js"), `console.log(${JSON.stringify(IMPOSTER)});\n`);
	writeFileSync(
		join(installed, "package.json"),
		'{"name":"@kampus/fabrika-cli","version":"9.9.9","bin":{"fabrika":"./bin.js"}}\n',
	);
});

afterAll(() => rmSync(consumer, {recursive: true, force: true}));

const invokeFromConsumer = (...args: ReadonlyArray<string>) => {
	try {
		const stdout = execFileSync(process.execPath, [BIN, ...args], {
			cwd: consumer,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return {code: 0, stdout, stderr: ""};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string; stderr?: string};
		return {code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? ""};
	}
};

describe("invoking this checkout's bin from a cwd in another checkout", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
	// The bin's own delegation is what is under test, so the guard that pins an invocation to this
	// copy has to stay unset — and vitest inherits the parent env.
	skip: process.env.FABRIKA_SKIP_INFER !== undefined,
}, () => {
	it("refuses instead of answering, and never lets the cwd's install speak", () => {
		const run = invokeFromConsumer("--version");
		expect(run.stdout).not.toContain(IMPOSTER);
		expect(run.code).toBe(NO_IMPLEMENTATION);
		expect(run.stderr).toContain("different repositories");
	});

	it("names both checkouts in the refusal, so the caller can see which copy it declined", () => {
		const run = invokeFromConsumer("--version");
		expect(run.stderr).toContain(consumer);
		expect(run.stderr).toContain(
			fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, ""),
		);
	});

	it("still serves the invocation itself under --skip-infer — the refusal has a way out", () => {
		const run = invokeFromConsumer("--skip-infer", "--version");
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("fabrika v");
		expect(run.stdout).not.toContain(IMPOSTER);
	});
});
