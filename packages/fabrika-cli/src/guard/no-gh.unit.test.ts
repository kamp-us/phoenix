/**
 * `guard no-gh check`'s matchers: the three call spellings it must catch, and the prose it must not.
 *
 * The false-positive half is as load-bearing as the true-positive half here. This package's source
 * quotes `gh` command text everywhere — `skill-lint.ts` forbids `gh api graphql` and has to name it,
 * every port docblock says what it replaced — so a matcher that flagged those would be turned off
 * within a week.
 */
import {describe, expect, it} from "vitest";
import {codeOf, isSelfExempt, isZeroScope, scanFile, scanPackage} from "./no-gh.ts";

const FILE = "packages/fabrika-cli/src/io/pulls.ts";

const matched = (content: string): ReadonlyArray<string> =>
	scanFile(FILE, content).map((f) => f.matched);

describe("scanFile catches every spelling of a call", () => {
	it("catches the binary named in argv position, whatever spawns it", () => {
		expect(matched('const r = yield* execCapture("gh", ["api", path]);')).toEqual(['"gh"']);
		expect(matched("execFileSync('gh', ['pr', 'merge']);")).toEqual(["'gh'"]);
		expect(matched('const spec = {file: "gh", args: ["auth", "token"]};')).toEqual(['"gh"']);
	});

	it("catches the backtick spelling of that same argv, which lint does not red either", () => {
		expect(matched('execCapture(`gh`, ["pr", "view", "1", "--json", "number"]);')).toEqual([
			"`gh`",
		]);
	});

	it("leaves a backticked `gh` in a string that no spawn stands beside — this is how prose spells it", () => {
		const note = 'const note = "a GitHub repo reachable over `gh` REST with `issues: write`";';
		expect(scanFile(FILE, note)).toEqual([]);
	});

	it("catches the shell-string spelling a -c argument hides", () => {
		const findings = scanFile(FILE, `execFileSync("sh", ["-c", "gh api repos/o/r --jq .id"]);`);
		expect(findings.map((f) => f.matched)).toContain('"gh api');
		expect(findings[0]?.line).toBe(1);
	});

	it("catches a call reached after a shell operator rather than at the string's start", () => {
		expect(matched("execSync(`git fetch origin && gh pr merge 42 --auto`);")).toContain("&& gh pr");
	});

	it("catches an argv call wrapped across lines by the formatter", () => {
		const wrapped = [
			'const out = execFileSync("sh", [',
			'\t"-c",',
			'\t"gh api rate_limit",',
			"]);",
		].join("\n");
		const findings = scanFile(FILE, wrapped);
		expect(findings.map((f) => f.matched)).toContain('"gh api');
		expect(findings.map((f) => f.line)).toContain(3);
	});
});

describe("scanFile leaves everything that is not a call alone", () => {
	it("ignores a docblock naming a command, which is what the port has to document", () => {
		const doc = [
			"/**",
			" * The header is read natively — the `gh api -i` era parsed it back out of stdout, and",
			" * `gh api --paginate` walked to exhaustion with nothing to refuse on.",
			" */",
			"export const read = () => 1;",
		].join("\n");
		expect(scanFile(FILE, doc)).toEqual([]);
	});

	it("ignores a line comment naming a command", () => {
		expect(scanFile(FILE, 'const x = 1; // was: execCapture("gh", ["api"])')).toEqual([]);
	});

	it("ignores a command string that no spawn stands beside — help text, a fixture, a message", () => {
		expect(scanFile(FILE, 'const help = "Example: gh api repos/o/r --jq .body";')).toEqual([]);
		expect(scanFile(FILE, 'const fixture = ["```bash", "gh pr edit 5", "```"];')).toEqual([]);
	});

	it("does not treat a `//` inside a string literal as the start of a comment", () => {
		expect(codeOf('const url = "https://api.github.com"; execCapture("gh", []);')[0]).toContain(
			'"gh"',
		);
	});
});

describe("the sanctioned leg and the self-exemptions", () => {
	const GH_API = "packages/fabrika-cli/src/io/gh-api.ts";

	/** The sanctioned leg as it really sits: inside `resolveToken`, at column 0. */
	const resolveToken = (body: string): string =>
		["export const resolveToken = (env) =>", "\tEffect.gen(function* () {", body, "\t});"].join(
			"\n",
		);

	it("allows ADR 0315's credential leg in the one file that holds it", () => {
		expect(
			scanFile(GH_API, resolveToken('\t\texecRecord({file: "gh", args: ["auth", "token"]});')),
		).toEqual([]);
	});

	it("still reds a different call added to that same file", () => {
		const findings = scanFile(GH_API, 'execFileSync("sh", ["-c", "gh pr merge"]);');
		expect(findings.map((f) => f.matched)).toContain('"gh pr');
	});

	/**
	 * The hole the sanction had until #6629's tail: keyed on the matched text alone, every argv spawn
	 * produced the same `"gh"`, so `gh-api.ts` held a file-wide licence for the one spelling most
	 * likely to come back.
	 */
	it("reds an argv spawn added to that file outside the sanctioned declaration", () => {
		const findings = scanFile(
			GH_API,
			[
				resolveToken('\t\texecRecord({file: "gh", args: ["auth", "token"]});'),
				"",
				"export const listPulls = () =>",
				'\texecCapture("gh", ["pr", "list"]);',
			].join("\n"),
		);
		expect(findings.map((f) => f.matched)).toEqual(['"gh"']);
	});

	it("reds a second argv spawn inside the sanctioned declaration — one sanction is one call", () => {
		const findings = scanFile(
			GH_API,
			resolveToken(
				[
					'\t\texecRecord({file: "gh", args: ["auth", "token"]});',
					'\t\texecRecord({file: "gh", args: ["pr", "list"]});',
				].join("\n"),
			),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.matched).toBe('"gh"');
	});

	it("reds the same leg in any other file — the sanction names one file", () => {
		const findings = scanFile(
			"packages/fabrika-cli/src/io/pulls.ts",
			resolveToken('\t\texecRecord({file: "gh", args: ["auth", "token"]});'),
		);
		expect(findings.map((f) => f.matched)).toEqual(['"gh"']);
	});

	it("exempts the guard's own files, which have to spell out what they forbid", () => {
		expect(isSelfExempt("packages/fabrika-cli/src/guard/no-gh.ts")).toBe(true);
		expect(isSelfExempt("packages/fabrika-cli/src/guard/no-gh.unit.test.ts")).toBe(true);
		expect(isSelfExempt("packages/fabrika-cli/src/guard/skill-lint.ts")).toBe(false);
	});
});

describe("scanPackage states the scope its verdict rests on", () => {
	it("counts every scanned file and drops the self-exempt ones from the scope", () => {
		const result = scanPackage([
			{file: FILE, content: "const x = 1;\n"},
			{file: "packages/fabrika-cli/src/guard/no-gh.ts", content: 'execCapture("gh", []);\n'},
		]);
		expect(result.scanned).toEqual([FILE]);
		expect(result.findings).toEqual([]);
		expect(isZeroScope(result)).toBe(false);
	});

	it("is zero scope when nothing was scanned, whatever the findings say", () => {
		expect(isZeroScope(scanPackage([]))).toBe(true);
	});
});
