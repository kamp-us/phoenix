/**
 * The `Pipeline` feature service (`.patterns/feature-services.md`,
 * `effect-context-service.md`) — one service, one method: assemble the structured
 * pipeline state for `kamp-us/phoenix` by fetching issues via `GithubClient` (the
 * I/O seam) and running the pure parse core (`parse.ts`) over them. The fetch and
 * the parse stay separated so the parse is unit-testable without the network (#252).
 *
 * No caching (out of scope per #252 — #254 owns it): every call re-fetches.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type {GithubFetchError} from "./errors.ts";
import {GithubClient} from "./github.ts";
import {isEpic, parseDependencies, parseLabels} from "./parse.ts";
import {PipelineEpic, PipelineIssue, PipelineState} from "./schema.ts";

/** Normalize GitHub's open/closed string to the two-state literal the schema pins. */
const normalizeState = (state: string): "open" | "closed" =>
	state === "closed" ? "closed" : "open";

export class Pipeline extends Context.Service<
	Pipeline,
	{
		readonly getState: Effect.Effect<PipelineState, GithubFetchError>;
	}
>()("@phoenix/dashboard/pipeline/Pipeline") {}

export const PipelineLive = Layer.effect(Pipeline)(
	Effect.gen(function* () {
		const github = yield* GithubClient;

		const getState = Effect.gen(function* () {
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

		return {getState};
	}),
);
