/**
 * The `vocabulary-preflight` tool — `pipeline-cli vocabulary-preflight check [--root <d>]`.
 *
 * The unmet-prerequisite check for an adopting repository (#4272). The pipeline's label
 * taxonomy and `ROADMAP.md` are hard dependencies, not defaults: run this once against a repo
 * before wiring the guards into its CI, and a missing label universe or roadmap surface reds by
 * name instead of letting every later scan match nothing and report clean.
 *
 *   pipeline-cli vocabulary-preflight check              # the resolved target repo (ADR 0062 §1)
 *   pipeline-cli vocabulary-preflight check --root <d>   # point at a specific repo root
 *
 * The pure decision lives in `vocabulary.ts` (unit-tested); the `gh api` label read and the
 * `ROADMAP.md` read in `github.ts`/`gate.ts`. `RepoLabelsLive` is baked in with
 * `Command.provide(...)` so the registered command's residual requirement is the Node platform
 * union (the registry seam, epic #994).
 *
 * Exit-code contract: 0 = every prerequisite met, any non-zero = failure.
 */
import {Effect, FileSystem, Option, Path} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {onCheckFailed} from "../../gate-fail.ts";
import {checkVocabulary} from "./gate.ts";
import {RepoLabelsLive} from "./github.ts";

// Repo-root markers, in priority order: a pnpm workspace, then a VCS dir.
const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"] as const;

// Walk up from cwd for the first ancestor bearing a repo-root marker, probing each marker through
// the `FileSystem`/`Path` seam so the resolver is testable off real disk
// (.patterns/effect-platform-access.md). The walk falls back to the start on no hit.
const defaultRoot = Effect.fn(function* (from: string = process.cwd()) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const start = path.resolve(from);
	let dir = start;
	for (;;) {
		for (const marker of ROOT_MARKERS) {
			if (yield* fs.exists(path.join(dir, marker)).pipe(Effect.orElseSucceed(() => false)))
				return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return start;
		dir = parent;
	}
});

const rootFlag = Flag.string("root").pipe(
	Flag.optional,
	Flag.withDescription("the repo root holding ROADMAP.md (default: walk up for one)"),
);

const resolveRoot = (
	root: Option.Option<string>,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
	Option.match(root, {onNone: () => defaultRoot(), onSome: Effect.succeed});

const check = Command.make(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root: rootOpt}) {
		yield* checkVocabulary(yield* resolveRoot(rootOpt)).pipe(
			Effect.catchTag("CheckFailed", onCheckFailed),
		);
	}),
).pipe(
	Command.withDescription(
		"Fail the run if the target repo lacks the pipeline's required labels or ROADMAP.md",
	),
);

export const vocabularyPreflightCommand = Command.make("vocabulary-preflight").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed preflight: the required label vocabulary + ROADMAP.md exist in the target repo (#4272)",
	),
	Command.provide(RepoLabelsLive),
);
