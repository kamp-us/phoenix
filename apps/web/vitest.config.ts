/**
 * Vitest config — the two test tiers of ADR 0082 (`unit` + `integration`, no
 * middle, no faked engine), `.patterns/alchemy-test-harness.md`.
 *
 *   - `unit` — pure logic + in-process service contracts: no deployed worker, all
 *     offline in the default node pool. Pure-logic files carry the `*.unit.test.ts`
 *     infix; the glob below catches both that and the plain `*.test.ts` service
 *     tests, colocated next to the module under test under `worker/**` and `src/**`.
 *   - `integration` — real behavior against **real remote Cloudflare D1** via the
 *     alchemy `Test.make` idiom: each file calls `integrationStack(import.meta.url)`
 *     (`tests/integration/_integration.ts`), which deploys the phoenix stack under
 *     its own **per-file isolated stage**, retries the first request through edge
 *     propagation, and asserts **black-box over HTTP**. No
 *     `@cloudflare/vitest-pool-workers`, no shared single deploy.
 *
 * Per-file isolated stages are the parallelism lever: each file owns its own worker
 * + D1, so files run in parallel rather than the prior forced single fork that
 * raced itself (#547 / #220 / #560 — one root cause, ADR 0082). The integration
 * project therefore enables `fileParallelism` (the inverse of the retired
 * single-fork model). `forks` + `disableConsoleIntercept` are retained for
 * stability against the alchemy deploy's child-process logging.
 */
import {defineConfig} from "vitest/config";

export default defineConfig({
	test: {
		// Run-scoped shared integration stage (ADR 0104 step 7, #1027): deploy the phoenix
		// Stack ONCE per run in globalSetup and `provide` its handle to forked files
		// (`tests/integration/_global-setup.ts` → `sharedStack()`). `globalSetup` is a
		// root-level `InlineConfig` key (Vitest forbids it per-project), so it runs for ANY
		// invocation of this config — including `test:unit`. The setup self-gates on
		// `vitest.projects` containing the `integration` project, so `--project unit` deploys
		// nothing. Nothing is migrated onto it yet (PR A is the substrate); only the throwaway
		// `sanity.shared.test.ts` reads it.
		globalSetup: "./tests/integration/_global-setup.ts",
		// `verbose` prints a ✓/✗ line per test (not just per file), so the slow
		// single-fork integration suite emits a steady heartbeat instead of going
		// silent for ~20s between files. Root-level on purpose: Vitest forbids a
		// per-project `reporters` (it's typed `never[]` in a project block — the
		// reporter aggregates the whole run), so both projects share it.
		reporters: ["verbose"],
		// A held `/fate/live` SSE stream that's still open when its client
		// disconnects has its response-body Effect fiber interrupted; the
		// interrupt-only `Cause` squashes to a generic
		// `Error("All fibers interrupted without error")` (effect-smol
		// `Cause.squash`), which the workerd isolate logs as an uncaught
		// exception and Vitest's main-process StateManager then collects as an
		// unhandled error — flipping a fully-green run's exit code to non-zero
		// (#20). The interrupt is benign (the client is already gone, no test
		// observes anything after it) and unfixable in the stream definition:
		// external fiber interruption can't be caught by any in-stream
		// combinator. Drop EXACTLY this one message (return `false`) so the
		// benign disconnect no longer fails the run, while every other unhandled
		// error still does — narrower than a blanket
		// `dangerouslyIgnoreUnhandledErrors`. See
		// `.patterns/effect-sse-externally-driven.md` ("Interruption on
		// disconnect").
		onUnhandledError: (error) =>
			error?.message === "All fibers interrupted without error" ? false : undefined,
		// `vitest --changed`/`related` narrows by the resolved import graph (ADR
		// 0082) — sound for the `unit` tier (its tests import disjoint modules, so a
		// change selects only the touched tests) and ideal for the inner dev loop.
		// But the graph can't see three out-of-band edges: migrations are SQL read
		// at runtime (no import edge), and `alchemy.run.ts` + the integration harness
		// substrate (`tests/integration/_*.ts`) are the deploy/black-box surface the
		// unit graph never reaches. `forceRerunTriggers` forces the FULL run when any
		// of them changes, so change-scoped selection never under-selects on an edge
		// the import graph misses. Root-level on purpose: Vitest reads this off the
		// global config, not per-project (it gates the `--changed` spec filter once
		// for the whole run). It does NOT narrow `integration` — that tier runs full,
		// parallelized via per-file isolated stages, never `--changed`-selected (ADR
		// 0082, "Change-scoped selection"). Keep the two built-in defaults
		// (`package.json`, the vitest/vite config) since setting this replaces them.
		forceRerunTriggers: [
			"**/package.json/**",
			"**/{vitest,vite}.config.*/**",
			"**/worker/db/drizzle/migrations/**",
			"**/alchemy.run.ts",
			"**/tests/integration/_*.ts",
		],
		projects: [
			{
				test: {
					name: "integration",
					include: ["tests/integration/**/*.test.ts"],
					// `*.unit.test.ts` under the integration dir are pure-logic tests of the
					// harness substrate (e.g. `_stage-name`), run in the `unit` tier — they
					// deploy nothing, so keep them out of the slow forks pool here.
					exclude: ["tests/integration/**/*.unit.test.ts"],
					// Each file's beforeAll(deploy(Stack)) provisions a real worker + D1
					// under an isolated stage and seeds over the network, then asserts over
					// HTTP — so a file's wall-clock is deploy + migrate + seed + assert.
					// Generous timeouts cover that. NO Vitest `retry`: the harness owns
					// per-request retries at the right layer, and a test-level retry would
					// re-enter `seedTerm` whose process-level (slug, body) dedup then reports
					// created:false / inserted:0 — breaking the seed assertions it retries.
					testTimeout: 120_000,
					hookTimeout: 180_000,
					pool: "forks",
					// Per-file isolated stages (ADR 0082): each file deploys its own
					// worker + D1, so files run in parallel — the inverse of the retired
					// single-fork model. `disableConsoleIntercept` keeps the alchemy
					// deploy's child-process logging from tripping Vitest's console wrapper
					// (EPIPE on the inherited pipe).
					fileParallelism: true,
					disableConsoleIntercept: true,
					// Cap concurrent forks: ~24 files each deploy/destroy their own `it-*`
					// stage against ONE shared, eventually-consistent CF account. Uncapped
					// (os.cpus-1) parallelism turned CF's create/destroy registry lag into
					// hard failures — WorkerNotFound(10007), "app referenced by Worker
					// script", "no versions" — forcing per-PR re-runs (#1010). `maxWorkers`
					// is the Vitest-4 key (v4 dropped `poolOptions.forks.maxForks`; only
					// project-level `test.maxWorkers` is read, scoping the cap to this tier
					// — resolveMaxWorkers, vitest@4.1.5). 4 is a reliability/wall-clock
					// tradeoff, tunable; CI wall-clock is addressed separately by sharding
					// (#684).
					maxWorkers: 4,
					// Vitest 4 requires a distinct `sequence.groupOrder` per project;
					// ordering integration before unit keeps the projects from interleaving.
					sequence: {groupOrder: 0},
				},
			},
			{
				test: {
					// The glob ends in `*.test.ts`, so it catches both the pure-logic
					// `*.unit.test.ts` files and the plain `*.test.ts` service-contract
					// tests — the `.unit` infix is a label, no separate `include` entry
					// needed.
					name: "unit",
					// Plus the pure-logic `*.unit.test.ts` of the integration harness
					// substrate (e.g. `_stage-name`) — they deploy nothing, so they run
					// here, not in the integration tier's forks pool.
					include: [
						"worker/**/*.test.ts",
						"src/**/*.test.ts",
						"tests/integration/**/*.unit.test.ts",
					],
					exclude: ["node_modules/**", "dist/**"],
					sequence: {groupOrder: 1},
				},
			},
		],
	},
});
