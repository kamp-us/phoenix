/**
 * `review preview` over a real subprocess: the golden fixture diff goes in, the placement split, the
 * exclusion enumeration, and the refusal seats come out. The fixture is a captured committed payload
 * asserted against its committed bytes, not a hand-built string at the call site.
 *
 * The cwd is the repo root so `.fabrika.jsonc`'s governedRoots feed the refusal union exactly as a
 * real invocation would; the refusal test derives its pattern from that same runtime config rather
 * than naming any repository's paths.
 */
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {GOVERNED_FILTER, OFF_VOCABULARY, PRECONDITION_UNKNOWN} from "./codes.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./__fixtures__/preview-sample.diff", import.meta.url));
const ABSENT_DIFF = join(dirname(FIXTURE), "preview-absent.diff");

// The first governed root the runtime itself will see — the refusal test proves the live union
// against it instead of hardcoding a path that only exists in one repository.
const firstGovernedRoot = (() => {
	const raw = readFileSync(`${REPO_ROOT}/.fabrika.jsonc`, "utf8").replace(/^\s*\/\/.*$/gm, "");
	const parsed = JSON.parse(raw) as {governedRoots: string[]};
	return parsed.governedRoots[0];
})();

const fabrika = (
	args: ReadonlyArray<string>,
	verb = "preview",
): {readonly code: number; readonly stdout: string; readonly stderr: string} => {
	try {
		return {
			code: 0,
			stdout: execFileSync(process.execPath, [BIN, "review", verb, ...args], {
				cwd: REPO_ROOT,
				encoding: "utf8",
				env: {...process.env, FABRIKA_SKIP_INFER: "1"},
				maxBuffer: 64 * 1024 * 1024,
				stdio: ["pipe", "pipe", "pipe"],
			}),
			stderr: "",
		};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string; stderr?: string};
		return {code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? ""};
	}
};

describe("review preview", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it.each([
		"scope",
		"diff",
		"preview",
	])("%s rejects before filtering before reading a subject", (verb) => {
		const run = fabrika(["4321", "--filter-placement=before"], verb);
		expect(run.code).toBe(10);
		expect(run.stderr).toContain("must be `after`");
	});

	it("placement after: the same diff keeps the full partition beside the excluded enumeration", () => {
		const run = fabrika(["--diff-file", FIXTURE, "--filter-placement=after", "--json"]);
		expect(run.code).toBe(0);
		const parsed = JSON.parse(run.stdout) as {
			placement: string;
			matched_paths: string[];
			excluded: {count: number; paths: string[]};
			active_classes: Array<{name: string; files: number}>;
			namespaces: string[];
		};
		expect(parsed.placement).toBe("after");
		expect(parsed.matched_paths).toEqual(["src/feature.ts"]);
		expect(parsed.excluded.count).toBe(2);
		expect(parsed.active_classes).toEqual([{name: "code", files: 3}]);
		expect(parsed.namespaces).toEqual(["review-code"]);
	});

	it("--emit-diff serves the header plus kept sections, never the excluded bytes", () => {
		const run = fabrika(["--diff-file", FIXTURE, "--filter-placement=after", "--emit-diff"]);
		expect(run.code).toBe(0);
		expect(run.stdout.startsWith("x-fabrika-filter: placement=after excluded=2 served=1\n")).toBe(
			true,
		);
		expect(run.stdout).toContain("x-fabrika-excluded-path: pnpm-lock.yaml");
		expect(run.stdout).toContain("x-fabrika-excluded-path: src/__snapshots__/feature.snap");
		expect(run.stdout).toContain("+export const featureExtra = () => 2;");
		expect(run.stdout).not.toContain("lockfileVersion");
	});

	it("an exclusion pattern reaching a governed root refuses at 21, proving the union is live", () => {
		const run = fabrika([
			"--diff-file",
			FIXTURE,
			"--filter-placement=after",
			"--exclude",
			`${firstGovernedRoot}**`,
		]);
		expect(run.code).toBe(GOVERNED_FILTER);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("intersects a governed root");
		expect(run.stderr).toContain(`${firstGovernedRoot}probe.md`);
	});

	it("the narrowed union accepts guard-corpus patterns — a package.json glob is not a governed root", () => {
		const run = fabrika([
			"--diff-file",
			FIXTURE,
			"--filter-placement=after",
			"--exclude",
			"**/package.json",
			"--json",
		]);
		expect(run.code).toBe(0);
		const parsed = JSON.parse(run.stdout) as {excluded: {count: number; paths: string[]}};
		expect(parsed.excluded.count).toBe(2);
		expect(parsed.excluded.paths).toEqual(["pnpm-lock.yaml", "src/__snapshots__/feature.snap"]);
	});

	it("an off-vocabulary placement refuses", () => {
		const run = fabrika(["--diff-file", FIXTURE, "--filter-placement=middle"]);
		expect(run.code).toBe(OFF_VOCABULARY);
	});

	it("a missing placement refuses — the spike exists to compare the two", () => {
		const run = fabrika(["--diff-file", FIXTURE]);
		expect(run.code).toBe(OFF_VOCABULARY);
	});

	it("--emit-diff and --json are mutually exclusive", () => {
		const run = fabrika([
			"--diff-file",
			FIXTURE,
			"--filter-placement=after",
			"--emit-diff",
			"--json",
		]);
		expect(run.code).toBe(OFF_VOCABULARY);
	});

	it("the line grammar prints the rows without --json or --emit-diff", () => {
		const run = fabrika(["--diff-file", FIXTURE, "--filter-placement=after"]);
		expect(run.code).toBe(0);
		expect(run.stdout.startsWith("preview\tafter\n")).toBe(true);
		expect(run.stdout).toContain("matched\t1");
		expect(run.stdout).toContain("class\tcode\t3");
		expect(run.stdout).toContain("namespace\treview-code");
		expect(run.stdout).toContain("excluded\t2");
		expect(run.stdout).toContain("excluded-path\tpnpm-lock.yaml");
		expect(run.stdout).toContain("excluded-path\tsrc/__snapshots__/feature.snap");
	});

	it("an unreadable --diff-file refuses at 11 — never a permissive empty read", () => {
		const run = fabrika(["--diff-file", ABSENT_DIFF, "--filter-placement=after"]);
		expect(run.code).toBe(PRECONDITION_UNKNOWN);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain(`cannot read --diff-file "${ABSENT_DIFF}"`);
	});
});
