/**
 * Service-level test for `Pipeline` over a STUB `GithubClient` (no network,
 * `.patterns/effect-testing.md` — `Layer.succeed` over the I/O seam). Exercises the
 * assembly the pure-parse units don't: that epics carry their `sub_issues` children
 * and the parsed `## Dependencies` topology, that PRs are not the client's concern
 * here (the stub returns only issues), and that the result validates.
 */
import {assert, describe, it} from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {GithubClient, type RawIssue, type RawSubIssue} from "./github.ts";
import {Pipeline, PipelineLive} from "./Pipeline.ts";
import {PipelineState} from "./schema.ts";

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

const StubGithub = Layer.succeed(GithubClient)(
	GithubClient.of({
		listIssues: Effect.succeed(issues),
		listSubIssues: (epic) => Effect.succeed(subIssuesByEpic[epic] ?? []),
	}),
);

const TestPipeline = PipelineLive.pipe(Layer.provide(StubGithub));

describe("Pipeline.getState", () => {
	it.effect("returns issues with parsed status/type/priority", () =>
		Effect.gen(function* () {
			const pipeline = yield* Pipeline;
			const state = yield* pipeline.getState;

			const api = state.issues.find((i) => i.number === 101)!;
			assert.strictEqual(api.parsed.type, "feature");
			assert.strictEqual(api.parsed.status, "triaged");
			assert.strictEqual(api.parsed.priority, "p2");
			assert.strictEqual(api.state, "closed");
		}).pipe(Effect.provide(TestPipeline)),
	);

	it.effect("attaches sub_issues children and parsed Dependencies topology to epics", () =>
		Effect.gen(function* () {
			const pipeline = yield* Pipeline;
			const state = yield* pipeline.getState;

			assert.strictEqual(state.epics.length, 1);
			const epic = state.epics[0]!;
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
		}).pipe(Effect.provide(TestPipeline)),
	);

	it.effect("produces a result that validates against the PipelineState schema", () =>
		Effect.gen(function* () {
			const pipeline = yield* Pipeline;
			const state = yield* pipeline.getState;
			assert.isTrue(state instanceof PipelineState);
		}).pipe(Effect.provide(TestPipeline)),
	);
});
