/**
 * Service-level test for `Pipeline` over stubbed seams (no network, no workerd,
 * `.patterns/effect-testing.md` — `Layer.succeed` over the I/O seams). Exercises
 * two things: the #252 assembly (epics carry their `sub_issues` children + parsed
 * `## Dependencies` topology, the result validates) and the #254 cache behavior
 * (cache hit within the TTL, refresh past it, stale-on-error fallback) driven with
 * `TestClock` so the TTL math is deterministic (`.patterns/effect-testing.md`).
 */
import {assert, describe, it} from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import {GithubFetchError} from "./errors.ts";
import {GithubClient, type RawIssue, type RawSubIssue} from "./github.ts";
import {CACHE_TTL_MS, Pipeline, PipelineLive} from "./Pipeline.ts";
import {PipelineCache} from "./PipelineCache.ts";
import {type CachedPipelineState, PipelineState} from "./schema.ts";

const issues: ReadonlyArray<RawIssue> = [
	{
		number: 100,
		title: "Pipeline dashboard epic",
		state: "open",
		labels: [{name: "type:epic"}, {name: "status:triaged"}, {name: "p1"}],
		body: [
			"An epic.",
			"",
			"## Dependencies",
			"",
			"### Phase 1",
			"- #101 — backend API",
			"",
			"### Phase 2",
			"- #102 — the SPA (requires: #101)",
		].join("\n"),
	},
	{
		number: 101,
		title: "backend API",
		state: "closed",
		labels: [{name: "type:feature"}, {name: "status:triaged"}, {name: "p2"}],
		body: null,
	},
	{
		number: 102,
		title: "the SPA",
		state: "open",
		labels: [{name: "type:feature"}, {name: "status:planned"}, {name: "p2"}],
		body: null,
	},
];

const subIssuesByEpic: Record<number, ReadonlyArray<RawSubIssue>> = {
	100: [{number: 101}, {number: 102}],
};

/**
 * A `GithubClient` stub counting `listIssues` calls (the cache hit/refresh AC is
 * verified by the count) and, when `fail` is set, failing the fetch (the
 * stale-on-error AC). The counter lives in a `Ref` so the test reads it back.
 */
const stubGithub = (calls: Ref.Ref<number>, options?: {readonly fail?: boolean}) =>
	Layer.succeed(GithubClient)(
		GithubClient.of({
			listIssues: Effect.gen(function* () {
				yield* Ref.update(calls, (n) => n + 1);
				if (options?.fail) {
					return yield* new GithubFetchError({
						path: "/repos/kamp-us/phoenix/issues",
						status: 503,
						message: "GitHub returned 503",
					});
				}
				return issues;
			}),
			listSubIssues: (epic) => Effect.succeed(subIssuesByEpic[epic] ?? []),
		}),
	);

/** An in-memory `PipelineCache` over a `Ref`, seedable so a test starts warm. */
const stubCache = (store: Ref.Ref<CachedPipelineState | null>) =>
	Layer.succeed(PipelineCache)(
		PipelineCache.of({
			read: Ref.get(store),
			write: (snapshot) => Ref.set(store, snapshot),
		}),
	);

describe("Pipeline.getState — assembly (#252)", () => {
	const TestPipeline = (calls: Ref.Ref<number>, store: Ref.Ref<CachedPipelineState | null>) =>
		PipelineLive.pipe(Layer.provide(stubGithub(calls)), Layer.provide(stubCache(store)));

	it.effect("returns issues with parsed status/type/priority", () =>
		Effect.gen(function* () {
			const calls = yield* Ref.make(0);
			const store = yield* Ref.make<CachedPipelineState | null>(null);
			const pipeline = yield* Pipeline.pipe(Effect.provide(TestPipeline(calls, store)));
			const response = yield* pipeline.getState;

			const api = response.state.issues.find((i) => i.number === 101)!;
			assert.strictEqual(api.parsed.type, "feature");
			assert.strictEqual(api.parsed.status, "triaged");
			assert.strictEqual(api.parsed.priority, "p2");
			assert.strictEqual(api.state, "closed");
			assert.strictEqual(response.stale, false);
		}).pipe(Effect.provide(TestClock.layer())),
	);

	it.effect("attaches sub_issues children and parsed Dependencies topology to epics", () =>
		Effect.gen(function* () {
			const calls = yield* Ref.make(0);
			const store = yield* Ref.make<CachedPipelineState | null>(null);
			const pipeline = yield* Pipeline.pipe(Effect.provide(TestPipeline(calls, store)));
			const response = yield* pipeline.getState;

			assert.strictEqual(response.state.epics.length, 1);
			const epic = response.state.epics[0]!;
			assert.strictEqual(epic.number, 100);
			assert.deepStrictEqual([...epic.children], [101, 102]);
			assert.deepStrictEqual(
				epic.dependencies.phases.map((p) => ({phase: p.phase, issues: [...p.issues]})),
				[
					{phase: 1, issues: [101]},
					{phase: 2, issues: [102]},
				],
			);
			assert.deepStrictEqual(
				epic.dependencies.requires.map((e) => ({from: e.from, to: e.to})),
				[{from: 102, to: 101}],
			);
			assert.isTrue(response.state instanceof PipelineState);
		}).pipe(Effect.provide(TestClock.layer())),
	);
});

describe("Pipeline.getState — caching + freshness (#254)", () => {
	const TestPipeline = (
		calls: Ref.Ref<number>,
		store: Ref.Ref<CachedPipelineState | null>,
		options?: {readonly fail?: boolean},
	) =>
		PipelineLive.pipe(Layer.provide(stubGithub(calls, options)), Layer.provide(stubCache(store)));

	it.effect("serves repeated loads within the TTL from cache, not a fresh GitHub call", () =>
		Effect.gen(function* () {
			const calls = yield* Ref.make(0);
			const store = yield* Ref.make<CachedPipelineState | null>(null);
			const pipeline = yield* Pipeline.pipe(Effect.provide(TestPipeline(calls, store)));

			const first = yield* pipeline.getState;
			assert.strictEqual(yield* Ref.get(calls), 1, "cold cache fetches once");

			// Stay within the TTL; the second load must not hit GitHub again.
			yield* TestClock.adjust(Duration.millis(CACHE_TTL_MS - 1));
			const second = yield* pipeline.getState;

			assert.strictEqual(yield* Ref.get(calls), 1, "cache hit — no second fetch");
			assert.strictEqual(second.stale, false);
			assert.strictEqual(second.fetchedAt, first.fetchedAt, "same snapshot served");
		}).pipe(Effect.provide(TestClock.layer())),
	);

	it.effect("refreshes from GitHub once the TTL elapses", () =>
		Effect.gen(function* () {
			const calls = yield* Ref.make(0);
			const store = yield* Ref.make<CachedPipelineState | null>(null);
			const pipeline = yield* Pipeline.pipe(Effect.provide(TestPipeline(calls, store)));

			const first = yield* pipeline.getState;
			assert.strictEqual(yield* Ref.get(calls), 1);

			// Past the TTL — the next load refreshes from GitHub.
			yield* TestClock.adjust(Duration.millis(CACHE_TTL_MS + 1));
			const refreshed = yield* pipeline.getState;

			assert.strictEqual(yield* Ref.get(calls), 2, "TTL elapsed — refetched");
			assert.strictEqual(refreshed.stale, false);
			assert.isTrue(refreshed.fetchedAt > first.fetchedAt, "fetchedAt advanced");
		}).pipe(Effect.provide(TestClock.layer())),
	);

	it.effect("falls back to the last good snapshot flagged stale when GitHub fails", () =>
		Effect.gen(function* () {
			const calls = yield* Ref.make(0);
			const store = yield* Ref.make<CachedPipelineState | null>(null);

			// Warm the cache with a successful fetch.
			const warm = yield* Pipeline.pipe(Effect.provide(TestPipeline(calls, store)));
			const fresh = yield* warm.getState;
			assert.strictEqual(fresh.stale, false);

			// Past the TTL, GitHub now fails — the board must serve the stale snapshot.
			yield* TestClock.adjust(Duration.millis(CACHE_TTL_MS + 1));
			const failing = yield* Pipeline.pipe(
				Effect.provide(TestPipeline(calls, store, {fail: true})),
			);
			const stale = yield* failing.getState;

			assert.strictEqual(stale.stale, true, "served stale, not errored");
			assert.strictEqual(stale.fetchedAt, fresh.fetchedAt, "stamped with the snapshot's age");
			assert.strictEqual(stale.state.issues.length, fresh.state.issues.length);
		}).pipe(Effect.provide(TestClock.layer())),
	);

	it.effect("surfaces the GitHub error on a cold cache (nothing to fall back to)", () =>
		Effect.gen(function* () {
			const calls = yield* Ref.make(0);
			const store = yield* Ref.make<CachedPipelineState | null>(null);
			const pipeline = yield* Pipeline.pipe(
				Effect.provide(TestPipeline(calls, store, {fail: true})),
			);

			const exit = yield* Effect.exit(pipeline.getState);
			assert.isTrue(exit._tag === "Failure", "cold-cache fetch failure propagates");
		}).pipe(Effect.provide(TestClock.layer())),
	);
});
