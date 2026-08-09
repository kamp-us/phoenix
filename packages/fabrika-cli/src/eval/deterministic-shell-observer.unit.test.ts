import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {observeShellCommand} from "./deterministic-shell-observer.ts";
import {
	type DeterministicCommand,
	runDeterministicTier,
	summarizeEvalRows,
	type TieredEvalCase,
} from "./deterministic-tier.ts";

/** Run an effect against the real Node platform — these suites are about the real OS boundary. */
const live = <A>(effect: Effect.Effect<A, never, NodeServices.NodeServices>): Promise<A> =>
	Effect.runPromise(Effect.provide(effect, NodeServices.layer));

const mechanical = (text: string, cue: string) => ({kind: "mechanical", text, cue}) as const;

const evalCase = (id: number, assertions: TieredEvalCase["assertions"]): TieredEvalCase => ({
	id,
	tier: "deterministic",
	assertions,
});

const sh = (script: string, cwd: string | null = null): DeterministicCommand => ({
	command: "bash",
	args: ["-c", script],
	cwd,
	timeoutMs: 10_000,
});

describe("observeShellCommand — a real process, never a model", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("reports the exit status and both streams of a run that answered", async () => {
		const observation = await live(
			observeShellCommand(evalCase(1, []), sh("printf out; printf err >&2; exit 3")),
		);
		assert.strictEqual(observation.exitStatus, 3);
		assert.strictEqual(observation.stdout, "out");
		assert.strictEqual(observation.stderr, "err");
		assert.strictEqual(observation.notRun, null);
	});

	it("reports a command that never started as notRun, not as a failing status (§ZS)", async () => {
		const observation = await live(
			observeShellCommand(evalCase(1, []), {
				command: "kampus-no-such-binary-4677",
				args: [],
				cwd: null,
				timeoutMs: 5_000,
			}),
		);
		assert.strictEqual(observation.notRun !== null, true);
		assert.strictEqual(observation.exitStatus, null);
	});

	it("distinguishes an exit 127 (ran, answered) from a did-not-run", async () => {
		const observation = await live(
			observeShellCommand(evalCase(1, []), sh("kampus-no-such-binary-4677")),
		);
		assert.strictEqual(observation.exitStatus, 127);
		assert.strictEqual(observation.notRun, null);
	});

	it("probes only the artifact paths the case's assertions name", async () => {
		const dir = mkdtempSync(join(tmpdir(), "eval-artifacts-"));
		try {
			writeFileSync(join(dir, "made.txt"), "x");
			const observation = await live(
				observeShellCommand(
					evalCase(1, [
						mechanical("a file named `made.txt` exists", "file-artifact"),
						mechanical("a file named `absent.txt` exists", "file-artifact"),
					]),
					sh("true", dir),
				),
			);
			assert.deepStrictEqual(observation.artifacts, ["made.txt"]);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	});

	it("cannot see tool invocations, and says so rather than answering no", async () => {
		const observation = await live(observeShellCommand(evalCase(1, []), sh("true")));
		assert.strictEqual(observation.toolInvocations, null);
	});
});

/**
 * The measurement AC4 asks for. Deliberately a real end-to-end pass — process spawn included —
 * because the subprocess is the only cost that matters at this tier; the pure judging is free.
 *
 * It asserts the observable outcome (a green suite over cases that hold, a red over one that
 * doesn't), never a wall-clock threshold: a timing assertion is exactly the flaky test the
 * ruling this tier implements calls a bug. The measured figure is recorded in the README, and
 * this suite is the command that re-measures it.
 */
describe("the deterministic tier end to end over a corpus-shaped set", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	const CASES = 20;

	const corpusShaped = (): ReadonlyArray<TieredEvalCase> =>
		Array.from({length: CASES}, (_, i) =>
			evalCase(i + 1, [
				mechanical("exits 0", "exit-status"),
				mechanical(`stdout contains 'case-${i + 1}'`, "output-content"),
			]),
		);

	it(`runs ${CASES} cases green, one run each`, async () => {
		const started = Date.now();
		const run = await live(
			runDeterministicTier({
				cases: corpusShaped(),
				resolveCommand: (c) => sh(`printf 'case-%s' ${c.id}`),
				observe: observeShellCommand,
				deferGraded: () => {
					throw new Error("a model was spawned for a deterministic case");
				},
			}),
		);
		const elapsedMs = Date.now() - started;
		const summary = summarizeEvalRows(run.rows);

		assert.strictEqual(summary.verdict, "green");
		assert.strictEqual(summary.total.cases, CASES);
		assert.deepStrictEqual(
			run.rows.map((r) => r.runs),
			Array.from({length: CASES}, () => 1),
		);
		// The figure the README records; printed so a re-measure is a read, not a rerun-and-time.
		console.log(`deterministic tier: ${CASES} cases in ${elapsedMs}ms`);
	});

	it("goes red on a case that genuinely fails — the tier is observed red, not assumed", async () => {
		const run = await live(
			runDeterministicTier({
				cases: [
					evalCase(1, [mechanical("exits 0", "exit-status")]),
					evalCase(2, [mechanical("exits 0", "exit-status")]),
				],
				resolveCommand: (c) => sh(c.id === 2 ? "exit 4" : "true"),
				observe: observeShellCommand,
			}),
		);
		const summary = summarizeEvalRows(run.rows);
		assert.strictEqual(summary.verdict, "red");
		assert.strictEqual(summary.total.failed, 1);
		assert.strictEqual(run.rows[1]?.detail, "exit status was 4, expected 0");
	});
});
