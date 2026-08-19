/**
 * `guard path-filter-guard check`'s IO boundary and exit taxonomy, over a scripted filesystem.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {runPathFilterGuard} from "./path-filter-verb.ts";

const ROOT = "/repo";
const CI = `${ROOT}/.github/workflows/ci.yml`;
const DEPLOY = `${ROOT}/.github/workflows/deploy.yml`;

const run = (options: FakeFsOptions, env: Record<string, string | undefined> = {}) =>
	Effect.runPromise(
		Effect.provide(runPathFilterGuard({root: ROOT, cwd: ROOT, env}), fakeFs(options).layer),
	);

const workflow = (key: string, globs: ReadonlyArray<string>): string => `
jobs:
  changes:
    steps:
      - uses: dorny/paths-filter@v3.0.2
        with:
          token: ''
          filters: |
            ${key}:
${globs.map((g) => `              - '${g}'`).join("\n")}
`;

const inSync = (): FakeFsOptions => ({
	files: {[CI]: workflow("e2e", ["a/**"]), [DEPLOY]: workflow("deploy", ["a/**"])},
});

const drifted = (): FakeFsOptions => ({
	files: {[CI]: workflow("e2e", ["a/**"]), [DEPLOY]: workflow("deploy", ["b/**"])},
});

describe("runPathFilterGuard", () => {
	it("passes two in-sync filter lists", async () => {
		const outcome = await run(inSync());
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("the deploy⊇e2e sync invariant holds");
	});

	it("seats a drift on the violation code with nothing on stdout", async () => {
		const outcome = await run(drifted());
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
	});

	// The drift is a relation, so neither file alone is the offender and both get marked.
	it("annotates both workflows under Actions", async () => {
		const outcome = await run(drifted(), {GITHUB_ACTIONS: "true"});
		const errors = outcome.stderr.filter((l) => l.startsWith("::error"));
		expect(errors.some((l) => l.includes("file=.github/workflows/ci.yml"))).toBe(true);
		expect(errors.some((l) => l.includes("file=.github/workflows/deploy.yml"))).toBe(true);
	});

	it.each([
		["neither workflow", {}],
		["only ci.yml", {[CI]: workflow("e2e", ["a/**"])}],
		["only deploy.yml", {[DEPLOY]: workflow("deploy", ["a/**"])}],
	])("fails closed with %s present", async (_name, files) => {
		const outcome = await run({files});
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("is UNKNOWN when a present workflow cannot be read", async () => {
		const outcome = await run({...inSync(), unreadable: [DEPLOY]});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
	});
});
