/**
 * The `vocabulary-preflight` gate — the IO seam wiring the pure core to the two facts it judges:
 * the target repo's label universe (over `gh api` via `RepoLabels`) and `ROADMAP.md` (read from
 * disk). Split from `command.ts` so the wiring is crossable in tests, and kept thin: it reads,
 * delegates the verdict to `vocabulary.ts`, and fails `CheckFailed` (exit non-zero) on any
 * non-passing verdict.
 */
import {Console, Effect, FileSystem, Path} from "effect";
import * as Schema from "effect/Schema";
import {parseRoadmap} from "../roadmap-guard/roadmap-guard.ts";
import type {RepoLabelsError} from "./github.ts";
import {RepoLabels} from "./github.ts";
import {judge, type RoadmapSurface, renderReport} from "./vocabulary.ts";

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

const ROADMAP_FILE = "ROADMAP.md";

/**
 * Read `ROADMAP.md` into the surface the core judges. An unreadable file resolves `absent` rather
 * than erroring: to a preflight, "the prerequisite is not there" and "the prerequisite cannot be
 * read" are the same unmet prerequisite, and both must red with the same name.
 *
 * The read goes through the `FileSystem`/`Path` seam so the wiring is crossable off real disk in a
 * test — see `.patterns/effect-platform-access.md`.
 */
export const readRoadmapSurface = (
	root: string,
): Effect.Effect<RoadmapSurface, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const target = path.join(root, ROADMAP_FILE);
		const md = yield* fs.readFileString(target, "utf8").pipe(Effect.orElseSucceed(() => null));
		if (md === null) return {_tag: "absent", path: target} as const;
		const {arcs, campaigns} = parseRoadmap(md);
		return {
			_tag: "present",
			path: target,
			arcs: arcs.length,
			campaigns: campaigns.length,
		} as const;
	});

/**
 * The preflight: read the label universe + the roadmap surface and judge the prerequisites.
 * Succeeds only on a passing verdict — an adopting repo missing the taxonomy gets a named,
 * non-zero failure instead of a factory that runs and protects nothing.
 */
export const checkVocabulary = (
	root: string,
): Effect.Effect<
	void,
	CheckFailed | RepoLabelsError,
	RepoLabels | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const universe = yield* (yield* RepoLabels).list();
		const roadmap = yield* readRoadmapSurface(root);
		const verdict = judge(universe, roadmap);
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
