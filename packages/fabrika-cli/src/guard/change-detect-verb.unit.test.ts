/**
 * `guard change-detect-guard check`'s IO boundary and exit taxonomy, over a scripted filesystem —
 * v1's single non-zero exit re-seated on the group's three.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {runChangeDetectGuard} from "./change-detect-verb.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";

const ROOT = "/repo";
const CI = `${ROOT}/.github/workflows/ci.yml`;

const run = (options: FakeFsOptions, env: Record<string, string | undefined> = {}) =>
	Effect.runPromise(
		Effect.provide(runChangeDetectGuard({root: ROOT, cwd: ROOT, env}), fakeFs(options).layer),
	);

const workflow = (withBlock: string): string => `
jobs:
  changes:
    steps:
      - uses: dorny/paths-filter@v3.0.2
        with:
${withBlock}
`;

const GIT_MODE = workflow("          token: ''\n          filters: 'a: x'");
const API_MODE = workflow("          filters: 'a: x'");

describe("runChangeDetectGuard", () => {
	it("passes the git-mode pin", async () => {
		const outcome = await run({files: {[CI]: GIT_MODE}});
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("API-free git-mode");
		expect(outcome.stderr).toEqual([]);
	});

	it("seats the API-mode regression on the violation code with nothing on stdout", async () => {
		const outcome = await run({files: {[CI]: API_MODE}});
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("#3245");
	});

	it("annotates ci.yml under Actions", async () => {
		const outcome = await run({files: {[CI]: API_MODE}}, {GITHUB_ACTIONS: "true"});
		expect(
			outcome.stderr.some((l) => l.startsWith("::error file=.github/workflows/ci.yml::")),
		).toBe(true);
	});

	it("emits no annotation off a runner", async () => {
		const outcome = await run({files: {[CI]: API_MODE}});
		expect(outcome.stderr.some((l) => l.startsWith("::"))).toBe(false);
	});

	// ADR 0092's floor: no ci.yml means nothing was compared, which cannot be reported clean.
	it("fails closed when ci.yml is absent", async () => {
		const outcome = await run({files: {}});
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("fails closed when the changes job holds no dorny step", async () => {
		const outcome = await run({
			files: {[CI]: "jobs:\n  changes:\n    steps:\n      - run: echo\n"},
		});
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	// Unreadable is not absent: one is a broken tree, the other a broken scope, and folding them
	// would let a permission fault read as "the workflow is simply gone".
	it("is UNKNOWN when ci.yml exists and cannot be read", async () => {
		const outcome = await run({files: {[CI]: GIT_MODE}, unreadable: [CI]});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
	});

	it("is UNKNOWN when no repo root can be discovered", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				runChangeDetectGuard({root: null, cwd: "/nowhere", env: {}}),
				fakeFs({}).layer,
			),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});
});
