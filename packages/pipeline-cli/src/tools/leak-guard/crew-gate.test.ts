/**
 * `sweepCrew` over a fake crew dir — the filesystem-seam test for #2357. The pure
 * generic match classes are covered in `crew-leak.unit.test.ts`; this crosses the IO
 * gate, asserting the exit-code contract from observable outcomes (never by spawning
 * the bin): a clean tree succeeds, a seeded-leak fixture `CheckFailed`s, and a zero-file
 * scope `CheckFailed`s (fail-closed, ADR 0092). Seeded fixtures use FAKE data only
 * (`alice@example.com`, `/Users/someone`) — no real identifier appears here.
 */
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "@effect/vitest";
import {Cause, Effect, Exit} from "effect";
import {CheckFailed, CREW_DIR, sweepCrew} from "./crew-gate.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "crew-sweep-"));
});
afterEach(() => {
	rmSync(root, {recursive: true, force: true});
});

const crewDir = () => {
	const dir = join(root, CREW_DIR);
	mkdirSync(dir, {recursive: true});
	return dir;
};
const writeCrewFile = (rel: string, body: string) => {
	const abs = join(root, CREW_DIR, rel);
	mkdirSync(join(abs, ".."), {recursive: true});
	writeFileSync(abs, body, "utf8");
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);
const isCheckFailed = (exit: Exit.Exit<unknown, unknown>): boolean =>
	Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof CheckFailed;

describe("sweepCrew — the CI exit-code gate over a fake crew dir", () => {
	it("SUCCEEDS on a clean tree (placeholder-only content, fictional examples)", async () => {
		writeCrewFile(
			"README.md",
			'# crew\nFill `operator.handle` with your own, e.g. `"@robin"`.\n' +
				// ${...} built via concatenation so it stays a literal, not a template string.
				`Copy \`$${"{CLAUDE_PLUGIN_ROOT}"}/crew.config.template.jsonc\`. See ../../.decisions/0062.md\n`,
		);
		writeCrewFile("agents/em.md", "The engineering-manager reports to <operator-name>.\n");
		const exit = await run(sweepCrew(root));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("FAILS (CheckFailed) on a seeded path leak", async () => {
		writeCrewFile("README.md", "clean\n");
		writeCrewFile("agents/em.md", "spawn from /Users/someone/code/x\n");
		expect(isCheckFailed(await run(sweepCrew(root)))).toBe(true);
	});

	it("FAILS (CheckFailed) on a seeded email leak", async () => {
		writeCrewFile("README.md", "ping alice@example.com\n");
		expect(isCheckFailed(await run(sweepCrew(root)))).toBe(true);
	});

	it("FAILS (CheckFailed) on a seeded tmux pane id", async () => {
		writeCrewFile("README.md", "ping the triage pane %11\n");
		expect(isCheckFailed(await run(sweepCrew(root)))).toBe(true);
	});

	it("FAILS (CheckFailed) on a seeded personal-memory reference", async () => {
		writeCrewFile("README.md", "recorded in MEMORY.md as feedback_grill_brevity\n");
		expect(isCheckFailed(await run(sweepCrew(root)))).toBe(true);
	});

	it("FAILS (CheckFailed, fail-closed) when zero files are in scope", async () => {
		crewDir(); // empty crew dir — no files
		expect(isCheckFailed(await run(sweepCrew(root)))).toBe(true);
	});
});
