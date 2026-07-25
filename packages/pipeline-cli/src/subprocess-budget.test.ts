/**
 * The subprocess test tier stays complete: every pipeline-cli test file that spawns a real child
 * process runs its suites under `SUBPROCESS_TEST_TIMEOUT_MS`, never vitest's 5s default (#4014).
 *
 * Without this the tier is a convention three files happened to follow, and the next spawning suite
 * re-earns the false red under load that #4014 was filed for.
 */
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));

const testFiles = (): readonly string[] =>
	(readdirSync(SRC, {recursive: true}) as string[]).filter((p) => p.endsWith(".test.ts"));

/**
 * A file that IMPORTS `node:child_process` spawns for real — that import statement is the tier
 * membership, matched as a statement rather than as a bare substring so this scanner (which names
 * the module in its own source) doesn't scan itself.
 */
const CHILD_PROCESS_IMPORT = /^import\s[^;]*\sfrom\s"node:child_process";$/m;

const spawningTestFiles = (): ReadonlyArray<readonly [string, string]> =>
	testFiles()
		.map((rel) => [rel, readFileSync(join(SRC, rel), "utf8")] as const)
		.filter(([, src]) => CHILD_PROCESS_IMPORT.test(src));

/**
 * Each `describe(` head, sliced up to its factory arrow — the window the `{timeout}` option must
 * sit in. Syntactic on purpose: the assertion is about the option being written at the suite, and
 * a suite-level option is what covers every `it` in the file, including ones added later.
 */
const describeHeads = (src: string): readonly string[] => {
	const heads: string[] = [];
	const re = /\bdescribe(?:\.\w+)?\s*\(/g;
	for (let m = re.exec(src); m !== null; m = re.exec(src)) {
		const arrow = src.indexOf("=>", m.index);
		heads.push(src.slice(m.index, arrow === -1 ? src.length : arrow));
	}
	return heads;
};

describe("every subprocess-spawning test suite carries the subprocess timeout budget (#4014)", () => {
	it("finds subprocess-spawning test files at all — fail closed on zero scope (ADR 0092)", () => {
		expect(spawningTestFiles().map(([rel]) => rel).length).toBeGreaterThan(0);
	});

	it("declares a `{timeout: SUBPROCESS_TEST_TIMEOUT_MS}` on every describe in every such file", () => {
		const offenders = spawningTestFiles().flatMap(([rel, src]) => {
			const heads = describeHeads(src);
			if (heads.length === 0) return [`${rel}: spawns a subprocess but declares no describe suite`];
			return heads
				.filter((head) => !head.includes("SUBPROCESS_TEST_TIMEOUT_MS"))
				.map((head) => `${rel}: ${head.split("\n")[0]?.trim()}`);
		});
		expect(offenders).toEqual([]);
	});
});
