/**
 * Vitest config — two projects: integration (alchemy/Test) + unit (node).
 *
 * `integration` deploys the real alchemy stack to a local workerd — offline,
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
 *
 * `unit` runs in the default node pool for isolation tests that don't need a
 * worker — Drizzle service contract tests, the fate bridge over a `node:sqlite`
 * D1, the Effect-DO instance builders over a DO-state fake, pure helpers. Unit
 * tests are colocated next to the module under test as `<module>.test.ts` under
 * `worker/**` and `src/**`.
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
					name: "unit",
					include: ["worker/**/*.test.ts", "src/**/*.test.ts"],
					exclude: ["tests/**", "node_modules/**", "dist/**"],
					sequence: {groupOrder: 1},
				},
			},
		],
	},
});
