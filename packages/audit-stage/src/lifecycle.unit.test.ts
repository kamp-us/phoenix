/**
 * The teardown-on-every-exit guarantee, asserted against an in-memory fake port — no
 * real deploy (ADR 0082 unit tier). This pins the load-bearing safety property of
 * #1512: a failed run must NEVER leave a live flag-on stage, so `destroy` is reached on
 * the happy path, on a mid-run phase failure, AND on the worst case — a deploy that
 * never resolved. The fake records the phase call order and can be told to fail at a
 * chosen phase; whether the REAL alchemy/better-auth/seed calls behave is the
 * integration concern (out of scope here — it needs a real Cloudflare deploy).
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit} from "effect";
import {
	type D1Target,
	type DeployResult,
	runStageLifecycle,
	StageLifecycleError,
	type StageLifecyclePort,
	type StagePhase,
	type TestMod,
} from "./lifecycle.ts";

const FAKE_TARGET: D1Target = {accountId: "acct-test", databaseId: "db-test"};
const FAKE_DEPLOY: DeployResult = {
	baseUrl: "https://it-audit.example.workers.dev",
	target: FAKE_TARGET,
};
const FAKE_TESTMOD: TestMod = {userId: "u-testmod", email: "mod@kamp.us", password: "pw-test"};

interface FakePort {
	readonly port: StageLifecyclePort;
	/** Phases reached, in call order — `destroy` appears iff teardown ran. */
	readonly calls: StagePhase[];
}

/**
 * A port that records each phase it's asked to run and, if `failAt` names a phase, fails
 * exactly there. `Effect.suspend` defers the `calls.push` to run-time, so the recorded
 * order reflects what the core actually drove (a phase the core never reached is absent).
 */
const makeFakePort = (failAt?: StagePhase): FakePort => {
	const calls: StagePhase[] = [];
	const step = <A>(phase: StagePhase, ok: A): Effect.Effect<A, StageLifecycleError> =>
		Effect.suspend(() => {
			calls.push(phase);
			return failAt === phase
				? Effect.fail(new StageLifecycleError({phase, message: `injected ${phase} failure`}))
				: Effect.succeed(ok);
		});
	const port: StageLifecyclePort = {
		deploy: () => step("deploy", FAKE_DEPLOY),
		previewSeed: () => step("preview-seed", undefined),
		mintTestMod: () => step("mint-test-mod", FAKE_TESTMOD),
		runHook: () => step("run-hook", undefined),
		destroy: () => step("destroy", undefined),
	};
	return {port, calls};
};

describe("runStageLifecycle — phase sequence", () => {
	it.effect("runs the four forward phases in order, then tears the stage down", () =>
		Effect.gen(function* () {
			const {port, calls} = makeFakePort();
			const result = yield* runStageLifecycle(port, "it-audit");
			assert.deepStrictEqual(calls, [
				"deploy",
				"preview-seed",
				"mint-test-mod",
				"run-hook",
				"destroy",
			]);
			assert.strictEqual(result.stage, "it-audit");
			assert.strictEqual(result.baseUrl, FAKE_DEPLOY.baseUrl);
			assert.deepStrictEqual(result.target, FAKE_TARGET);
			assert.deepStrictEqual(result.testMod, FAKE_TESTMOD);
		}),
	);
});

describe("runStageLifecycle — teardown is guaranteed on every failure path", () => {
	it.effect("a deploy failure STILL tears down (the worst path — no surviving stage)", () =>
		Effect.gen(function* () {
			const {port, calls} = makeFakePort("deploy");
			const exit = yield* Effect.exit(runStageLifecycle(port, "it-audit"));
			assert.isTrue(Exit.isFailure(exit));
			// destroy is keyed on the stage name alone, so even a deploy that never
			// resolved is torn down — the load-bearing #1512 property.
			assert.deepStrictEqual(calls, ["deploy", "destroy"]);
		}),
	);

	it.effect("a preview-seed failure STILL tears down and halts the forward phases", () =>
		Effect.gen(function* () {
			const {port, calls} = makeFakePort("preview-seed");
			const exit = yield* Effect.exit(runStageLifecycle(port, "it-audit"));
			assert.isTrue(Exit.isFailure(exit));
			assert.deepStrictEqual(calls, ["deploy", "preview-seed", "destroy"]);
		}),
	);

	it.effect("a mint-test-mod failure STILL tears down", () =>
		Effect.gen(function* () {
			const {port, calls} = makeFakePort("mint-test-mod");
			const exit = yield* Effect.exit(runStageLifecycle(port, "it-audit"));
			assert.isTrue(Exit.isFailure(exit));
			assert.deepStrictEqual(calls, ["deploy", "preview-seed", "mint-test-mod", "destroy"]);
		}),
	);

	it.effect("an audit-run (hook) crash STILL tears down", () =>
		Effect.gen(function* () {
			const {port, calls} = makeFakePort("run-hook");
			const exit = yield* Effect.exit(runStageLifecycle(port, "it-audit"));
			assert.isTrue(Exit.isFailure(exit));
			assert.deepStrictEqual(calls, [
				"deploy",
				"preview-seed",
				"mint-test-mod",
				"run-hook",
				"destroy",
			]);
		}),
	);

	it.effect("the failing phase is reported in the surfaced error", () =>
		Effect.gen(function* () {
			const {port} = makeFakePort("mint-test-mod");
			const err = yield* Effect.flip(runStageLifecycle(port, "it-audit"));
			assert.strictEqual(err._tag, "@kampus/audit-stage/StageLifecycleError");
			assert.strictEqual(err.phase, "mint-test-mod");
		}),
	);

	it.effect("a teardown failure surfaces loudly (a leaked stage is never silent)", () =>
		Effect.gen(function* () {
			// the body succeeds; destroy itself fails — the run must still report failure
			const {port, calls} = makeFakePort("destroy");
			const exit = yield* Effect.exit(runStageLifecycle(port, "it-audit"));
			assert.isTrue(Exit.isFailure(exit));
			assert.deepStrictEqual(calls, [
				"deploy",
				"preview-seed",
				"mint-test-mod",
				"run-hook",
				"destroy",
			]);
		}),
	);
});
