/**
 * The `Pipeline` feature service (`.patterns/feature-services.md`,
 * `effect-context-service.md`) — assemble the structured pipeline state for
 * `kamp-us/phoenix` by fetching issues via `GithubClient` (the I/O seam) and
 * running the pure parse core (`parse.ts`) over them. The fetch and the parse
 * stay separated so the parse is unit-testable without the network (#252).
 *
 * Caching (#254) wraps the fetch at this seam — the cut point #252 flagged. A TTL
 * cache fronts the GitHub fetch via `PipelineCache`: serve the cached snapshot
 * within the TTL, refresh past it. On a GitHub failure, fall back to the last good
 * snapshot marked `stale` (with its `fetchedAt`) rather than erroring the whole
 * board; only a cold-cache failure surfaces the error. The TTL comparison reads
 * `Clock`, so `getState` is testable with `TestClock`.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type {GithubFetchError} from "./errors.ts";
import {GithubClient} from "./github.ts";
import {PipelineCache} from "./PipelineCache.ts";
import {isEpic, parseDependencies, parseLabels} from "./parse.ts";
import {
	CachedPipelineState,
	PipelineEpic,
	PipelineIssue,
	PipelineResponse,
	PipelineState,
} from "./schema.ts";

/** How long a fetched snapshot stays fresh before a load refreshes it from GitHub. */
export const CACHE_TTL_MS = 60_000;

/** Normalize GitHub's open/closed string to the two-state literal the schema pins. */
const normalizeState = (state: string): "open" | "closed" =>
	state === "closed" ? "closed" : "open";

export class Pipeline extends Context.Service<
	Pipeline,
	{
		readonly getState: Effect.Effect<PipelineResponse, GithubFetchError>;
	}
>()("@phoenix/dashboard/pipeline/Pipeline") {}

export const PipelineLive = Layer.effect(Pipeline)(
	Effect.gen(function* () {
		const github = yield* GithubClient;
		const cache = yield* PipelineCache;

		/** Fetch + parse the live pipeline state from GitHub (the pre-#254 path). */
		const fetchState = Effect.gen(function* () {
			const raw = yield* github.listIssues;

			const issues = raw.map((issue) => {
				const labels = issue.labels.map((l) => l.name);
				return new PipelineIssue({
					number: issue.number,
					title: issue.title,
					state: normalizeState(issue.state),
					labels,
					parsed: parseLabels(labels),
				});
			});

			// Epics carry the two extra relations: their sub_issues children and the
			// parsed `## Dependencies` topology off the body. Fetch children per epic
			// (concurrently) and parse the topology from the already-fetched body.
			const rawEpics = raw.filter((issue) => isEpic(issue.labels.map((l) => l.name)));
			const epics = yield* Effect.forEach(
				rawEpics,
				(issue) =>
					Effect.gen(function* () {
						const labels = issue.labels.map((l) => l.name);
						const children = yield* github.listSubIssues(issue.number);
						return new PipelineEpic({
							number: issue.number,
							title: issue.title,
							state: normalizeState(issue.state),
							labels,
							parsed: parseLabels(labels),
							children: children.map((c) => c.number),
							dependencies: parseDependencies(issue.body),
						});
					}),
				{concurrency: 8},
			);

			return new PipelineState({issues, epics});
		});

		// Refresh from GitHub, persist the snapshot, return it fresh — or on a GitHub
		// failure fall back to `cached` marked stale, propagating the error only when
		// the cache is cold (`cached === null`).
		const refresh = (cached: CachedPipelineState | null) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;
				const state = yield* fetchState;
				yield* cache.write(new CachedPipelineState({state, fetchedAt: now}));
				return new PipelineResponse({
					issues: state.issues,
					epics: state.epics,
					fetchedAt: now,
					stale: false,
				});
			}).pipe(
				Effect.catchTag("@phoenix/dashboard/pipeline/GithubFetchError", (error) =>
					cached === null
						? Effect.fail(error)
						: Effect.succeed(
								new PipelineResponse({
									issues: cached.state.issues,
									epics: cached.state.epics,
									fetchedAt: cached.fetchedAt,
									stale: true,
								}),
							),
				),
			);

		const getState = Effect.gen(function* () {
			const cached = yield* cache.read;
			if (cached !== null) {
				const now = yield* Clock.currentTimeMillis;
				if (now - cached.fetchedAt < CACHE_TTL_MS) {
					return new PipelineResponse({
						issues: cached.state.issues,
						epics: cached.state.epics,
						fetchedAt: cached.fetchedAt,
						stale: false,
					});
				}
			}
			return yield* refresh(cached);
		});

		return {getState};
	}),
);
