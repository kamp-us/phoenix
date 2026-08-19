/**
 * `guard codeowners-cp check`'s IO boundary and exit taxonomy, over a scripted filesystem.
 *
 * The fixture CODEOWNERS is generated FROM the live boundary rather than hand-written, so a branch
 * added to `control-plane-re.ts` cannot leave these cases quietly asserting over a stale set.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {cpPaths} from "./codeowners-cp.ts";
import {runCodeownersCpGuard} from "./codeowners-cp-verb.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {CONTROL_PLANE_RE} from "./control-plane-re.ts";

const ROOT = "/repo";
const CODEOWNERS = `${ROOT}/.github/CODEOWNERS`;

const run = (options: FakeFsOptions, env: Record<string, string | undefined> = {}) =>
	Effect.runPromise(
		Effect.provide(runCodeownersCpGuard({root: ROOT, cwd: ROOT, env}), fakeFs(options).layer),
	);

/** A CODEOWNERS owning every §CP path the live boundary resolves, minus the named ones. */
const owningAllBut = (...dropped: ReadonlyArray<string>): string =>
	cpPaths(CONTROL_PLANE_RE)
		.map((p) => p.path)
		.filter((p) => !dropped.includes(p))
		.map((p) => `/${p} @kamp-us/control-plane`)
		.join("\n");

describe("runCodeownersCpGuard", () => {
	it("passes when every §CP path is owned", async () => {
		const outcome = await run({files: {[CODEOWNERS]: owningAllBut()}});
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("§CP path(s) are covered");
	});

	// The #955 defect verbatim: a §CP path in the boundary with no CODEOWNERS row behind it.
	it("seats a dropped §CP row on the violation code, naming the path", async () => {
		const outcome = await run({files: {[CODEOWNERS]: owningAllBut(".github/")}});
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain(".github/");
	});

	it("annotates CODEOWNERS under Actions", async () => {
		const outcome = await run(
			{files: {[CODEOWNERS]: owningAllBut(".claude/")}},
			{GITHUB_ACTIONS: "true"},
		);
		expect(outcome.stderr.some((l) => l.startsWith("::error file=.github/CODEOWNERS::"))).toBe(
			true,
		);
	});

	// ADR 0092's floor, twice over: no file and no owned row are both "nothing is owned", and an
	// owner-less CODEOWNERS is exactly the shape that would otherwise pass vacuously.
	it("fails closed when CODEOWNERS is absent", async () => {
		expect((await run({files: {}})).code).toBe(ZERO_SCOPE);
	});

	it("fails closed when CODEOWNERS assigns no owners at all", async () => {
		const outcome = await run({files: {[CODEOWNERS]: "# only comments\n/.github/\n"}});
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("is UNKNOWN when CODEOWNERS exists and cannot be read", async () => {
		const outcome = await run({files: {[CODEOWNERS]: owningAllBut()}, unreadable: [CODEOWNERS]});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
	});
});
