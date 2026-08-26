// @patch-pin: effect@4.0.0-beta.92
/**
 * The documented `--` separator binds its trailing argv to the leaf verb's declared argument
 * (#7115).
 *
 * The vendored parser reset the lexer's post-`--` operands when it recursed into a subcommand, so
 * every token after `--` was bound two levels up and dropped before the leaf's params saw it — a
 * verb following its own help-text example failed with `"0 values"` for an argument the caller did
 * supply, and a verb with optional variadic positionals silently bound zero. The fix lives in
 * `patches/effect@4.0.0-beta.92.patch` (`parseArgs` threading `trailingOperands` through the
 * recursion); this file is its behavior pin, in the same register as `excess-operand.cli.test.ts`:
 * only a subprocess proves what a shell caller reads, and each case asserts the **exit code and
 * stderr**, never stdout content that could pass against the bug.
 *
 * Every spawn is offline and deterministic: the verbs are driven to their first post-parse refusal,
 * which is exactly the boundary the fix moves — "the tokens arrived" is proven by which refusal
 * answers.
 */
import {execFileSync} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {BASE_UNFETCHABLE} from "./adr/codes.ts";
import {NO_WORKSPACE} from "./spike/codes.ts";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "./test-budget.ts";

const BIN = fileURLToPath(new URL("./bin.ts", import.meta.url));

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** `FABRIKA_SKIP_INFER` pins the invocation to *this* copy rather than whatever the root installs. */
const fabrika = (args: ReadonlyArray<string>, cwd: string = process.cwd()): Run => {
	try {
		const stdout = execFileSync(process.execPath, [BIN, ...args], {
			cwd,
			encoding: "utf8",
			env: {...process.env, FABRIKA_SKIP_INFER: "1"},
			stdio: ["ignore", "pipe", "pipe"],
		});
		return {code: 0, stdout, stderr: ""};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string; stderr?: string};
		return {
			code: failure.status ?? -1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
		};
	}
};

const scratchDir = (): string => mkdtempSync(join(tmpdir(), "fabrika-7115-"));

describe("the documented -- separator binds its trailing argv", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	// `spike run`'s own help text shows this shape. Before the patch it answered the parse error
	// `Invalid value for argument <command>: "0 values"` on exit 1 — blaming `<command>` for tokens
	// that were present. Reaching NO_WORKSPACE proves parsing succeeded and the verb ran.
	it("spike run parses its help-text example and reaches the verb boundary", () => {
		const run = fabrika(["spike", "run", "--nonce", "e15b99bd", "--", "echo", "hello"]);
		expect(run.code).toBe(NO_WORKSPACE);
		expect(run.stderr).toContain("no workspace for nonce e15b99bd");
		expect(run.stderr).not.toContain("Invalid value");
	});

	// Parity control: the undocumented separator-less form must land on the same refusal as the
	// documented one, so the docs' shape is never the worse one.
	it("the same invocation without -- reaches the same verb boundary", () => {
		const run = fabrika(["spike", "run", "--nonce", "e15b99bd", "echo", "hello"]);
		expect(run.code).toBe(NO_WORKSPACE);
	});

	// A required variadic positional binds post-`--` tokens too: `adr resolve` gets past argument
	// binding and refuses at its first git read instead (a non-repo cwd keeps that read offline;
	// `--repo` seats the refusal on BASE_UNFETCHABLE rather than an ambiguous 1).
	it("adr resolve binds its ids after -- instead of reporting 0 values", () => {
		const run = fabrika(["adr", "resolve", "--repo", "owner/name", "--", "0164"], scratchDir());
		expect(run.code).toBe(BASE_UNFETCHABLE);
		expect(run.stderr).toContain("cannot fetch");
		expect(run.stderr).not.toContain("Invalid value");
	});

	// An optional variadic positional must not silently bind zero: with the operand dropped the verb
	// would answer its own no-term refusal (exit 1, `no term given`); bound, it reads the register.
	it("glossary lookup treats a term after -- as given", () => {
		const run = fabrika(["glossary", "lookup", "--dir", scratchDir(), "--", "front door"]);
		expect(run.stdout).toContain("absent\t-\t-\t-");
		expect(run.stderr).not.toContain("no term given");
	});
});

describe("what the excess-operand guard already refused still refuses", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	// Pre-patch, post-`--` operands were dropped above the leaf entirely, so an undeclared one after
	// `--` slipped past the catch-all in silence. Threaded through, it lands there and is refused.
	it("an undeclared operand after -- is refused loudly, naming the token", () => {
		const run = fabrika(["adr", "next", "--", "extratoken"]);
		expect(run.code).toBe(1);
		expect(run.stderr).toContain('unexpected operand "extratoken"');
		expect(run.stdout).toBe("");
	});
});
