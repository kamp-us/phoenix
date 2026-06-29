/**
 * The on-demand run's load-bearing properties, asserted against in-memory fakes — no real
 * deploy and no real agent walk (ADR 0082 unit tier). The capstone guarantee (#1517 / epic
 * #1510, story 10): a run ALWAYS tears its stage down — on the happy path, AND when the
 * agentic walk crashes mid-run, AND when the archive write fails — so no flag-on stage is
 * ever left alive. The walk and archive are injected seams, so the property is proven without
 * a real explorer or a real Cloudflare deploy. The happy path also pins that the per-dimension
 * verdict is built and surfaced to the operator.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	type D1Target,
	type DeployResult,
	StageLifecycleError,
	type StageLifecyclePort,
	type TestMod,
} from "@kampus/audit-stage";
import type {DimensionResult} from "@kampus/audit-verdict";
import {Effect, Exit} from "effect";
import {type AuditArchiver, type AuditWalk, formatOperatorSummary, runAuditOnce} from "./run.ts";

const FAKE_TARGET: D1Target = {accountId: "acct-test", databaseId: "db-test"};
const FAKE_DEPLOY: DeployResult = {
	baseUrl: "https://it-audit.example.workers.dev",
	target: FAKE_TARGET,
};
const FAKE_TESTMOD: TestMod = {userId: "u-testmod", email: "mod@kamp.us", password: "pw-test"};
const NOW = "2026-06-28T00:00:00.000Z";

interface FakePort {
	readonly port: StageLifecyclePort;
	/** Phase calls in order; `destroy` appears iff teardown ran. The core overrides `runHook`. */
	readonly calls: string[];
}

const makeFakePort = (): FakePort => {
	const calls: string[] = [];
	const port: StageLifecyclePort = {
		deploy: () =>
			Effect.sync(() => {
				calls.push("deploy");
				return FAKE_DEPLOY;
			}),
		previewSeed: () => Effect.sync(() => void calls.push("preview-seed")),
		mintTestMod: () =>
			Effect.sync(() => {
				calls.push("mint-test-mod");
				return FAKE_TESTMOD;
			}),
		// The core replaces this with its walk seam; the original is never reached.
		runHook: () => Effect.sync(() => void calls.push("port-run-hook")),
		destroy: () => Effect.sync(() => void calls.push("destroy")),
	};
	return {port, calls};
};

const DIM_PASS: DimensionResult = {
	dimension: "functional-rite",
	status: "PASS",
	findings: [
		{
			dimension: "functional-rite",
			check: "tier-flip",
			surface: "/profile",
			status: "PASS",
			expected: "yazar",
			observed: "yazar",
			evidence: "screenshot:profile",
		},
	],
};
const DIM_FAIL: DimensionResult = {
	dimension: "sandbox-leak",
	status: "FAIL",
	findings: [
		{
			dimension: "sandbox-leak",
			check: "sandboxed-hidden",
			surface: "/search",
			status: "FAIL",
			expected: "hidden",
			observed: "visible",
			evidence: "screenshot:search",
		},
	],
};

const okArchive: AuditArchiver = () =>
	Effect.succeed({jsonPath: "rite-audit/runs/x.json", mdPath: "rite-audit/runs/x.md"});
const failArchive: AuditArchiver = () =>
	Effect.fail(new StageLifecycleError({phase: "run-hook", message: "injected archive failure"}));

describe("runAuditOnce — full run, verdict surfaced", () => {
	it.effect(
		"provisions, walks, archives, surfaces the per-dimension verdict, then tears down",
		() =>
			Effect.gen(function* () {
				const {port, calls} = makeFakePort();
				const walk: AuditWalk = () => Effect.succeed([DIM_PASS, DIM_FAIL]);
				const result = yield* runAuditOnce(
					{port, walk, archive: okArchive, now: () => NOW},
					"it-audit",
				);

				assert.deepStrictEqual(calls, ["deploy", "preview-seed", "mint-test-mod", "destroy"]);
				assert.strictEqual(result.stage, "it-audit");
				assert.strictEqual(result.baseUrl, FAKE_DEPLOY.baseUrl);
				// any FAIL dimension ⇒ overall FAIL (story 11, recomputed by buildVerdict)
				assert.strictEqual(result.verdict.overall, "FAIL");
				assert.deepStrictEqual(result.verdict.perDimension, [
					{dimension: "functional-rite", status: "PASS"},
					{dimension: "sandbox-leak", status: "FAIL"},
				]);
				assert.strictEqual(result.verdict.date, NOW);
				assert.strictEqual(result.archived.jsonPath, "rite-audit/runs/x.json");

				const summary = formatOperatorSummary(result);
				assert.match(summary, /rite-audit: FAIL/);
				assert.match(summary, /PASS {2}functional-rite/);
				assert.match(summary, /FAIL {2}sandbox-leak/);
				assert.match(summary, /stage torn down/);
			}),
	);

	it.effect("an all-PASS walk yields an overall-PASS verdict", () =>
		Effect.gen(function* () {
			const {port} = makeFakePort();
			const walk: AuditWalk = () => Effect.succeed([DIM_PASS]);
			const result = yield* runAuditOnce(
				{port, walk, archive: okArchive, now: () => NOW},
				"it-audit",
			);
			assert.strictEqual(result.verdict.overall, "PASS");
		}),
	);
});

describe("runAuditOnce — teardown is guaranteed even when the run-hook fails", () => {
	it.effect("a mid-run agentic-walk CRASH STILL tears the stage down (story 10)", () =>
		Effect.gen(function* () {
			const {port, calls} = makeFakePort();
			const walk: AuditWalk = () =>
				Effect.fail(new StageLifecycleError({phase: "run-hook", message: "injected walk crash"}));
			const exit = yield* Effect.exit(
				runAuditOnce({port, walk, archive: okArchive, now: () => NOW}, "it-audit"),
			);
			assert.isTrue(Exit.isFailure(exit));
			// destroy ran despite the walk crash — no surviving flag-on stage
			assert.deepStrictEqual(calls, ["deploy", "preview-seed", "mint-test-mod", "destroy"]);
		}),
	);

	it.effect("an ARCHIVE failure STILL tears the stage down", () =>
		Effect.gen(function* () {
			const {port, calls} = makeFakePort();
			const walk: AuditWalk = () => Effect.succeed([DIM_PASS]);
			const exit = yield* Effect.exit(
				runAuditOnce({port, walk, archive: failArchive, now: () => NOW}, "it-audit"),
			);
			assert.isTrue(Exit.isFailure(exit));
			assert.deepStrictEqual(calls, ["deploy", "preview-seed", "mint-test-mod", "destroy"]);
		}),
	);

	it.effect("the run-hook failure is reported in the surfaced error", () =>
		Effect.gen(function* () {
			const {port} = makeFakePort();
			const walk: AuditWalk = () =>
				Effect.fail(new StageLifecycleError({phase: "run-hook", message: "injected walk crash"}));
			const err = yield* Effect.flip(
				runAuditOnce({port, walk, archive: okArchive, now: () => NOW}, "it-audit"),
			);
			assert.strictEqual(err._tag, "@kampus/audit-stage/StageLifecycleError");
			assert.strictEqual(err.phase, "run-hook");
		}),
	);
});
