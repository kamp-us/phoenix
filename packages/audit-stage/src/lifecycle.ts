/**
 * The pure orchestration core of the rite-audit stage lifecycle (#1512, epic #1510):
 * provision an ephemeral isolated audit stage, prepare it, mint a test-mod, run the
 * audit hook, and ALWAYS tear it down. The audit stage deploys on the dedicated `audit`
 * environment so #1511's force-on rule makes `phoenix-authorship-loop` active there
 * (never prod) — a live flag-on stage is exactly what must never be left behind.
 *
 * This module is the *core*: a single `Effect` over an injected {@link StageLifecyclePort},
 * holding only the phase SEQUENCE and the teardown-on-every-exit guarantee. Every real
 * effect (alchemy deploy/destroy, better-auth sign-up, the seeds) lives behind the port,
 * so the safety property — teardown runs on success, on a mid-run failure, and on a
 * deploy failure — is unit-tested against an in-memory fake with no real deploy
 * (`lifecycle.unit.test.ts`). The thin bin wires the real port (`adapter.ts`).
 *
 * The teardown guarantee rests on two facts:
 *   1. `Effect.onExit` runs its finalizer on EVERY exit — success, failure, defect, and
 *      interruption — so no body error can skip teardown.
 *   2. Teardown is keyed on the stage NAME alone (`port.destroy(stage)`), never on the
 *      deploy output, so even a deploy that failed mid-provision is still torn down
 *      (`alchemy destroy --stage <stage>` is idempotent over whatever state exists).
 * A failed teardown surfaces loudly in the error channel rather than being swallowed —
 * a leaked flag-on stage is the one outcome this core exists to make impossible.
 */
import {Effect} from "effect";
import * as Schema from "effect/Schema";

/** The lifecycle phases, in order. `deploy` provisions AND migrates the stage D1 (alchemy applies the worker `migrationsDir` at deploy — see `apps/web/worker/db/resources.ts`), so "migrate" is a sub-step of deploy, not a separate port op. */
export const STAGE_PHASES = [
	"deploy",
	"preview-seed",
	"mint-test-mod",
	"run-hook",
	"destroy",
] as const;

export type StagePhase = (typeof STAGE_PHASES)[number];

/** A phase of the lifecycle failed. `phase` names which step so a caller (and the bin's log) can attribute the fault; `message` carries the underlying detail. */
export class StageLifecycleError extends Schema.TaggedErrorClass<StageLifecycleError>()(
	"@kampus/audit-stage/StageLifecycleError",
	{
		phase: Schema.Literals(STAGE_PHASES),
		message: Schema.String,
	},
) {}

/** The deployed stage's real D1 coordinates — what the seeds write against over the REST transport. */
export interface D1Target {
	readonly accountId: string;
	readonly databaseId: string;
}

/** What a successful deploy resolves: the worker's base URL (printed for the operator) and the migrated D1. */
export interface DeployResult {
	readonly baseUrl: string;
	readonly target: D1Target;
}

/**
 * The minted test-mod identity — a real registered account promoted to moderator+yazar.
 * `userId` is the better-auth `user.id` returned by the no-verify sign-up (its presence
 * proves the çaylak self-registration yielded a session); `email`/`password` are the
 * login credentials a downstream audit drives the divan with.
 */
export interface TestMod {
	readonly userId: string;
	readonly email: string;
	readonly password: string;
}

export interface PreviewSeedInput {
	readonly target: D1Target;
}

export interface MintTestModInput {
	readonly baseUrl: string;
	readonly target: D1Target;
}

/** The context handed to the audit run hook (#1513 fills it; #1512 ships it as a no-op seam). */
export interface AuditRunInput {
	readonly stage: string;
	readonly baseUrl: string;
	readonly target: D1Target;
	readonly testMod: TestMod;
}

/** What a completed lifecycle returns to the bin — the run's facts (the stage was torn down by the time this resolves). */
export interface StageRunResult {
	readonly stage: string;
	readonly baseUrl: string;
	readonly target: D1Target;
	readonly testMod: TestMod;
}

/**
 * The injected effectful boundary the core orchestrates. The real implementation
 * (`adapter.ts`) wires alchemy, better-auth, and the seed packages; the unit test wires
 * an in-memory fake. Every method fails in the `StageLifecycleError` channel tagged with
 * its phase.
 */
export interface StageLifecyclePort {
	/** Provision + migrate a fresh isolated stage on the `audit` environment; resolve its base URL + D1. */
	readonly deploy: (stage: string) => Effect.Effect<DeployResult, StageLifecycleError>;
	/** Seed the baseline read corpus into the stage D1 (`@kampus/preview-seed`). */
	readonly previewSeed: (input: PreviewSeedInput) => Effect.Effect<void, StageLifecycleError>;
	/** Register a fresh çaylak via better-auth, then promote it to moderator+yazar (`@kampus/founder-seed`). */
	readonly mintTestMod: (input: MintTestModInput) => Effect.Effect<TestMod, StageLifecycleError>;
	/** The audit-run seam (#1513); a no-op in #1512. */
	readonly runHook: (input: AuditRunInput) => Effect.Effect<void, StageLifecycleError>;
	/** Tear the stage down (`alchemy destroy --stage <stage>`) — idempotent over whatever state exists. */
	readonly destroy: (stage: string) => Effect.Effect<void, StageLifecycleError>;
}

/**
 * Run the full audit-stage lifecycle for `stage`, with teardown guaranteed on every exit.
 *
 * The body runs the four forward phases in order (deploy → preview-seed → mint-test-mod →
 * run-hook); `Effect.onExit` then runs `destroy` whether the body succeeded, failed, or was
 * interrupted. Because `destroy` only needs the stage name, a deploy that fails mid-provision
 * is still torn down — so no failure path can leave a live flag-on stage. A `destroy` fault is
 * not swallowed: it surfaces in the error channel (combined with any body error), making a
 * leaked stage loud rather than silent.
 */
export const runStageLifecycle = (
	port: StageLifecyclePort,
	stage: string,
): Effect.Effect<StageRunResult, StageLifecycleError> =>
	Effect.gen(function* () {
		const {baseUrl, target} = yield* port.deploy(stage);
		yield* port.previewSeed({target});
		const testMod = yield* port.mintTestMod({baseUrl, target});
		yield* port.runHook({stage, baseUrl, target, testMod});
		return {stage, baseUrl, target, testMod} satisfies StageRunResult;
	}).pipe(Effect.onExit(() => port.destroy(stage)));
