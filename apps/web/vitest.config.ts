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
import react from "@vitejs/plugin-react";
import {defineConfig} from "vitest/config";
// Single-source the integration hook ceiling (#3146). The value declared here is DEAD for every
// `Test.make`-registered hook — alchemy passes an explicit per-hook timeout that overrides
// `config.hookTimeout` (see `HOOK_TIMEOUT_MS`), so `integrationStack` must ALSO thread it. Importing
// it here keeps the config and the threaded value provably equal (the module is import-side-effect free).
import {HOOK_TIMEOUT_MS} from "./tests/integration/_edge-ready.ts";

export default defineConfig({
	// The `client` project below renders `*.test.tsx` through React's JSX runtime,
	// so the JSX transform must be present — this config is loaded standalone
	// (`--config vitest.config.ts`), not merged with `vite.config.ts`. The plugin
	// only rewrites JSX/TSX, so it's inert for the `.ts` worker/unit tiers.
	plugins: [react()],
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
					// Generous timeouts cover that. No project-level Vitest `retry`: the harness
					// owns per-request retries at the right layer, and a test-level retry would
					// re-enter `seedTerm` whose process-level (slug, body) dedup then reports
					// created:false / inserted:0 — breaking the seed assertions it retries.
					// Exception: two files carry a file-local `describe(..., {retry: 2})` #3075
					// stopgap (search-error-vs-empty, kunye-relation-store) — neither re-enters
					// `seedTerm` on retry, so the dedup hazard above doesn't apply. Reversible;
					// drops when #3075's durable ci.yml worker-relevance filter lands.
					testTimeout: 120_000,
					// Silently overridden for `Test.make` hooks by alchemy's explicit per-hook timeout
					// (`integrationStack` threads `{timeout: HOOK_TIMEOUT_MS}` to honor it); kept here,
					// single-sourced, for any non-alchemy hook + to document the real ceiling (#3146).
					hookTimeout: HOOK_TIMEOUT_MS,
					pool: "forks",
					// `isolate: false` shares one parsed JS module graph across the files
					// that run in the same fork, so the phoenix worker barrel chain
					// (`_integration.ts` → `alchemy.run.ts` → `worker/index.ts`, ~132 TS
					// files, ~62% alchemy/CF SDK eval) is imported+transformed ONCE per fork
					// instead of re-imported from scratch per file (#958, diagnosed in #682).
					// This is Vitest's JS-module-registry isolation — DISTINCT from the
					// per-file isolated D1 *stage* (ADR 0082/0104): it does NOT merge the
					// real-D1 worker deploys, only the in-fork module cache. Safe here because
					// the harness holds no cross-file module-level mutable singleton (the
					// shared stage handle arrives via `provide`, not a module global); a
					// fully-green integration tier is the contamination proof.
					// CI A/B (recorded on PR #958): integration-job wall-clock 251s median
					// (isolate:true baseline, n=5 main runs) → 203s (isolate:false), ≈19% faster.
					isolate: false,
					// Per-file isolated stages (ADR 0082): each file deploys its own
					// worker + D1, so files run in parallel — the inverse of the retired
					// single-fork model. `disableConsoleIntercept` keeps the alchemy
					// deploy's child-process logging from tripping Vitest's console wrapper
					// (EPIPE on the inherited pipe).
					fileParallelism: true,
					disableConsoleIntercept: true,
					// No fork cap: ADR 0104 step 7 (#1027) collapsed the per-run deploy
					// surface from ~24 ephemeral `it-*` stages to ~6 — one shared
					// `globalSetup` deploy plus the 5 by-design dedicated files
					// (fate-live-posts / fts-backfill / search-error-vs-empty, plus
					// search / sozluk-keyset — the keyset paged-walk files, #1143: their
					// lead-sort statistic is a cross-file-global corpus stat (bm25 corpus
					// stats / total_score), so a parallel fork's writes between page requests
					// re-rank the walk mid-cursor → skips/dupes; a dedicated stage gives a
					// stable corpus across the walk, per ADR 0104 — paged-walk files stay
					// dedicated). The ~9 shared-stage files no longer deploy; they reuse the already-deployed
					// shared worker over HTTP. The retired fork cap of 4 (#1010) only
					// existed to throttle the ~24 concurrent create/destroy storm that raced
					// CF's eventually-consistent registry; that storm is structurally gone, so
					// uncapped `fileParallelism` no longer races it.
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
						// Pure-core tests of the headless build tooling (the node-core
						// bundle assertion, #1836) — no deployed worker, runs offline here.
						"scripts/**/*.unit.test.ts",
					],
					exclude: ["node_modules/**", "dist/**"],
					sequence: {groupOrder: 1},
				},
			},
			{
				test: {
					// The SPA component/DOM tier (#1419): renders the client's real React
					// shells (the `Screen` error boundary, hook drivers) and queries the
					// DOM. It's a sibling of `unit`, not a replacement — `unit` keeps its
					// pure-core `*.test.ts`; this tier owns the `*.test.tsx` that need a
					// `jsdom` document. Worker-side tiers are untouched: the `unit` glob is
					// `*.test.ts` (never `.tsx`), so a file lands in exactly one tier.
					name: "client",
					include: ["src/**/*.test.tsx"],
					environment: "jsdom",
					setupFiles: ["./tests/client/setup.ts"],
					exclude: ["node_modules/**", "dist/**"],
					// Bound the fork worker's V8 heap (#1470). An effect-driven hook
					// under `renderHook` can enter an unbounded *passive*-update loop
					// (effect -> setState -> re-render -> effect ...): React's "Maximum
					// update depth exceeded" guard only catches updates scheduled
					// synchronously within a commit, never passive-effect updates spread
					// across ticks -- so a buggy test (or an unmemoized `args`/`deps`, the
					// exact footgun `useImperativeView` warns about) spins forever.
					// Uncapped, the fork ballooned to ~4.8GB RSS and hung ~66s before
					// Vitest force-terminated it -- an opaque "the seam OOMs" that drove
					// agents to route AROUND this tier back to pure-core tests, defeating
					// #1419. Capping old-space turns the runaway into a fast, contained
					// heap-OOM crash (~7s, well under a GB) so the failure reads as the
					// test's bug, not infra. The limit sits comfortably above every
					// legitimate jsdom+React render here.
					pool: "forks",
					// Vitest 4 reads per-project fork exec args off a top-level `execArgv`
					// (poolOptions was removed in the v4 pool rework), passed to the fork as
					// node flags.
					execArgv: ["--max-old-space-size=512"],
					sequence: {groupOrder: 2},
				},
			},
		],
	},
});
