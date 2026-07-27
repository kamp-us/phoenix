/**
 * The `vocabulary-seed` wiring — the IO seam between the pure core and the two surfaces a run
 * touches: the target repo's labels (over `gh api`) and `ROADMAP.md` on disk.
 *
 * Split from `command.ts` so the whole plan/apply path is crossable in a test with a stubbed
 * spawner and an in-memory filesystem.
 */
import {Console, Effect, FileSystem, Path} from "effect";
import * as Schema from "effect/Schema";
import {LABEL_SPECS} from "../vocabulary-preflight/vocabulary.ts";
import type {SeederError} from "./github.ts";
import {LabelSeeder} from "./github.ts";
import {
	type LabelResult,
	planLabels,
	ROADMAP_SCAFFOLD,
	type RoadmapPlan,
	renderPlan,
	renderResult,
	type SeedPlan,
	seedPrecondition,
} from "./seed.ts";

/** Carries the non-zero exit for a refusal (the reason is already composed). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

const ROADMAP_FILE = "ROADMAP.md";

/**
 * Decide the roadmap half. An existing `ROADMAP.md` is KEPT, always — the seeder's job is to make
 * a bare repo pipeline-ready, and silently overwriting a maintained roadmap with a scaffold is the
 * one destructive thing this tool could do. That makes the file write safe by construction rather
 * than by a confirmation prompt.
 */
const planRoadmap = (
	root: string,
): Effect.Effect<RoadmapPlan, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const target = path.join(root, ROADMAP_FILE);
		const exists = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false));
		return exists
			? ({_tag: "keep", path: target} as const)
			: ({_tag: "create", path: target} as const);
	});

const buildPlan = (
	root: string,
): Effect.Effect<SeedPlan, SeederError, LabelSeeder | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const seeder = yield* LabelSeeder;
		const repo = yield* seeder.repo;
		const universe = yield* seeder.list();
		const {create, present} = planLabels(LABEL_SPECS, universe);
		return {repo, create, present, roadmap: yield* planRoadmap(root)};
	});

const refuseIfUnwired = Effect.suspend(() => {
	const defect = seedPrecondition();
	return defect === null ? Effect.void : Effect.fail(new CheckFailed({reason: defect}));
});

/** `plan` — read-only. Resolves the target, diffs the taxonomy, prints what `apply` would do. */
export const planSeed = (
	root: string,
): Effect.Effect<
	void,
	CheckFailed | SeederError,
	LabelSeeder | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		yield* refuseIfUnwired;
		yield* Console.log(renderPlan(yield* buildPlan(root)));
	});

/**
 * `apply` — the write. Creates only the labels the plan found missing, writes `ROADMAP.md` only if
 * absent, and prints the resolved target BEFORE the first write so a mis-targeted run is visible
 * in the log rather than only in the repo it hit.
 */
export const applySeed = (
	root: string,
): Effect.Effect<
	void,
	CheckFailed | SeederError,
	LabelSeeder | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		yield* refuseIfUnwired;
		const plan = yield* buildPlan(root);
		yield* Console.log(
			`vocabulary-seed: target repo ${plan.repo} — creating ${plan.create.length} label(s).`,
		);
		const seeder = yield* LabelSeeder;
		const results: Array<LabelResult> = plan.present.map((name) => ({
			name,
			outcome: "already-exists" as const,
		}));
		for (const spec of plan.create) {
			results.push({name: spec.name, outcome: yield* seeder.create(spec)});
		}
		if (plan.roadmap._tag === "create") {
			const fs = yield* FileSystem.FileSystem;
			yield* fs.writeFileString(plan.roadmap.path, ROADMAP_SCAFFOLD).pipe(
				Effect.mapError(
					(cause) =>
						new CheckFailed({
							reason: `vocabulary-seed: labels are seeded, but writing ${plan.roadmap.path} failed — ${cause.message}`,
						}),
				),
			);
		}
		yield* Console.log(renderResult(plan.repo, results, plan.roadmap));
	});
