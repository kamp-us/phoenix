/**
 * `review preview` over a real subprocess: the golden fixture diff goes in, the placement split, the
 * exclusion enumeration, and the refusal seats come out. The fixture is a captured committed payload
 * (ADR 0180), not a hand-built string at the call site.
 *
 * The cwd is the repo root so `.fabrika.jsonc`'s governedRoots feed the refusal union exactly as a
 * real invocation would.
 */
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {OFF_VOCABULARY, GOVERNED_FILTER} from "./codes.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./__fixtures__/preview-sample.diff", import.meta.url));

const fabrika = (args: ReadonlyArray<string>): {readonly code: number; readonly stdout: string; readonly stderr: string} => {
	try {
		return {
			code: 0,
			stdout: execFileSync(process.execPath, [BIN, "review", "preview", ...args], {
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
	it("placement before: the lockfile and snapshot are excluded and only code survives the partition", () => {
		const run = fabrika(["--diff-file", FIXTURE, "--filter-placement=before", "--json"]);
		if (run.code !== 0) console.log("PREVIEW-CLI-STDERR:", run.stderr);
		expect(run.code).toBe(0);
		const parsed = JSON.parse(run.stdout) as {
			placement: string;
			matched_paths: string[];
			excluded: {count: number; paths: string[]};
			active_classes: Array<{name: string; files: number}>;
			namespaces: string[];
			filtered_diff_bytes: number;
		};
		expect(parsed.placement).toBe("before");
		expect(parsed.matched_paths).toEqual(["src/feature.ts"]);
		expect(parsed.excluded).toEqual({
			count: 2,
			paths: ["pnpm-lock.yaml", "src/__snapshots__/feature.snap"],
		});
		expect(parsed.active_classes).toEqual([{name: "code", files: 1}]);
		expect(parsed.namespaces).toEqual(["review-code"]);
		expect(parsed.filtered_diff_bytes).toBeGreaterThan(0);
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
		const run = fabrika(["--diff-file", FIXTURE, "--filter-placement=before", "--emit-diff"]);
		expect(run.code).toBe(0);
		expect(run.stdout.startsWith("x-fabrika-filter: placement=before excluded=2 served=1\n")).toBe(true);
		expect(run.stdout).toContain("x-fabrika-excluded-path: pnpm-lock.yaml");
		expect(run.stdout).toContain("x-fabrika-excluded-path: src/__snapshots__/feature.snap");
		expect(run.stdout).toContain("+export const featureExtra = () => 2;");
		expect(run.stdout).not.toContain("lockfileVersion");
	});

	it("an exclusion pattern reaching a governed root refuses at 21, proving the union is live", () => {
		const run = fabrika(["--diff-file", FIXTURE, "--filter-placement=before", "--exclude", ".decisions/**"]);
		expect(run.code).toBe(GOVERNED_FILTER);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("intersects a governed root");
		expect(run.stderr).toContain(".decisions/probe.md");
	});

	it("the narrowed union accepts guard-corpus patterns — a package.json glob is not a governed root", () => {
		const run = fabrika(["--diff-file", FIXTURE, "--filter-placement=before", "--exclude", "**/package.json", "--json"]);
		expect(run.code).toBe(0);
		const parsed = JSON.parse(run.stdout) as { excluded: { count: number; paths: string[] } };
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
		const run = fabrika(["--diff-file", FIXTURE, "--filter-placement=before", "--emit-diff", "--json"]);
		expect(run.code).toBe(OFF_VOCABULARY);
	});
});
