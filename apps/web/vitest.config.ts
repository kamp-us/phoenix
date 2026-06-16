/**
 * Vitest config — two projects mapping onto the T0–T3 taxonomy (ADR 0040,
 * `.patterns/effect-testing.md`). A tier is *which layer satisfies a fixed
 * R-channel*, not a folder; the project boundary is the workerd process boundary.
 *
 *   - `unit` (this config's `unit` project) hosts T0–T2 — everything reachable
 *     in-process by `Effect.provide`, all offline in the default node pool:
 *       T0  pure logic, zero storage, tagged `*.unit.test.ts` (the glob below
 *           already catches them — a label, not a third project, which would
 *           re-trigger Vitest 4's distinct-`sequence.groupOrder` rule);
 *       T1  a feature service over a real `node:sqlite` D1 (`Vote.test.ts`);
 *       T2  fate ops through the full worker layer (`sozluk.test.ts`,
 *           `sozluk-keyset.test.ts`, `products.test.ts`, `app.test.ts`) + the
 *           DO instance factory over a DO-state fake.
 *     T1/T2 keep the plain `*.test.ts` suffix. Tests are colocated next to the
 *     module under test under `worker/**` and `src/**`.
 *   - `integration` (this config's `integration` project) hosts T3 — the
 *     deployed alchemy stack on local workerd, asserted black-box over HTTP. NOT
 *     a layer: there is no R-channel to provide to. Reserve it for what the
 *     in-process algebra can't reach (deployed-worker smoke, DO+SSE+D1); domain
 *     correctness belongs down in T1/T2 where `node:sqlite` is faithful & offline.
 *
 * `integration` (T3) deploys the real alchemy stack to a local workerd — offline,
 * `dev: true` + `Alchemy.localState()` — once per run in `tests/integration/_global-setup.ts`
 * (the Vitest **main process**, the only context where the alchemy dev sidecar's
 * Node-side LoopbackServer comes up reliably; see `tests/integration/_harness.ts`).
 * The deployed URL is published via `PHOENIX_TEST_URL`; the suites under
 * `tests/integration/` then assert **black-box over HTTP** against it — no
 * `@cloudflare/vitest-pool-workers` (which cannot load the alchemy worker).
 *
 * The integration project runs in a single long-lived fork with no isolation and
 * with console-intercept disabled: the workerd sidecar (spawned by the main
 * process) inherits stdout, and Vitest's console wrapper otherwise breaks that
 * inherited pipe (EPIPE). `_global-setup.ts` (where the sidecar actually lives) is
 * the main process, so this only affects how the HTTP-only test fork is run.
 */
import {defineConfig} from "vitest/config";

export default defineConfig({
	test: {
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
		projects: [
			{
				test: {
					name: "integration",
					include: ["tests/integration/**/*.test.ts"],
					globalSetup: ["./tests/integration/_global-setup.ts"],
					// Seed-heavy tests (`sozluk-read` seeds + paginates) make dozens of
					// sequential round-trips to real Cloudflare D1 — no offline D1 — and
					// the harness retries the occasional stalled request (see `_harness.ts`
					// `REQUEST_TIMEOUT_MS`), so a slow test needs headroom above the raw
					// work. NO Vitest `retry`: the harness owns per-request retries at the
					// right layer, and a test-level retry would re-enter `seedTerm` whose
					// process-level (slug, body) dedup then reports created:false /
					// inserted:0 — breaking the very seed assertions it would be retrying.
					testTimeout: 120_000,
					hookTimeout: 120_000,
					pool: "forks",
					// Vitest 4: `singleFork: true` → `maxWorkers: 1, isolate: false`. One
					// long-lived fork, no per-file isolation — the HTTP-only test fork
					// stays cheap and stable while the workerd sidecar lives in the main
					// process (see `_global-setup.ts`).
					maxWorkers: 1,
					isolate: false,
					fileParallelism: false,
					disableConsoleIntercept: true,
					// Vitest 4 requires a distinct `sequence.groupOrder` when projects
					// differ in `maxWorkers`; ordering integration before unit also keeps
					// the single-fork integration run from overlapping the unit pool.
					sequence: {groupOrder: 0},
				},
			},
			{
				test: {
					// T0–T2 (see the header). The glob ends in `*.test.ts`, so it
					// catches both the plain `*.test.ts` (T1/T2) and the T0
					// `*.unit.test.ts` files — the `.unit` infix is a label, no
					// separate `include` entry needed.
					name: "unit",
					include: ["worker/**/*.test.ts", "src/**/*.test.ts"],
					exclude: ["tests/**", "node_modules/**", "dist/**"],
					sequence: {groupOrder: 1},
				},
			},
		],
	},
});
