/**
 * The `vocabulary-seed` tool — `pipeline-cli vocabulary-seed <plan|apply> [--repo o/n] [--root d]`.
 *
 * The write half of adopter bootstrap (#4341). `vocabulary-preflight` tells a fresh repo which
 * labels and roadmap surface it lacks; `doctor` prints the `gh label create` lines; neither runs
 * them, so the taxonomy got hand-copied. This runs them.
 *
 *   pipeline-cli vocabulary-seed plan                    # read-only preview — what would be written
 *   pipeline-cli vocabulary-seed apply                   # create the missing labels + ROADMAP.md
 *   pipeline-cli vocabulary-seed apply --repo owner/name # name the target explicitly
 *
 * The done-test is another tool's green: after `apply`, `pipeline-cli vocabulary-preflight check`
 * passes.
 *
 * It creates NO GitHub milestones. ADR 0072 makes creating or restructuring a milestone an
 * explicitly human roadmap decision, and this tool does not reinterpret that for the bootstrap
 * case — the seeded `ROADMAP.md` says who does it and how.
 *
 * The pure decision lives in `seed.ts`, the `gh api` reads/writes in `github.ts`, the wiring in
 * `gate.ts`. Exit-code contract: 0 = done, non-zero = refused or failed.
 */
import {Effect, FileSystem, Option, Path} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {onCheckFailed} from "../../gate-fail.ts";
import {applySeed, planSeed} from "./gate.ts";
import {layer} from "./github.ts";

// Repo-root markers, in priority order: a pnpm workspace, then a VCS dir. Same resolution the
// preflight uses, so the two tools read and write the same `ROADMAP.md`.
const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"] as const;

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
	Flag.withDescription("the repo root to write ROADMAP.md into (default: walk up for one)"),
);

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target repo as owner/name — takes precedence over CLAUDE_PIPELINE_REPO and `gh repo view`",
	),
);

const resolveRoot = (
	root: Option.Option<string>,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
	Option.match(root, {onNone: () => defaultRoot(), onSome: Effect.succeed});

const plan = Command.make(
	"plan",
	{root: rootFlag, repo: repoFlag},
	Effect.fn(function* ({root, repo}) {
		yield* planSeed(yield* resolveRoot(root)).pipe(
			Effect.provide(layer(Option.getOrUndefined(repo))),
			Effect.catchTag("CheckFailed", onCheckFailed),
		);
	}),
).pipe(
	Command.withDescription(
		"Preview the seed against the resolved target repo — writes nothing (start here)",
	),
);

const apply = Command.make(
	"apply",
	{root: rootFlag, repo: repoFlag},
	Effect.fn(function* ({root, repo}) {
		yield* applySeed(yield* resolveRoot(root)).pipe(
			Effect.provide(layer(Option.getOrUndefined(repo))),
			Effect.catchTag("CheckFailed", onCheckFailed),
		);
	}),
).pipe(
	Command.withDescription(
		"Create the missing pipeline labels in the target repo and scaffold ROADMAP.md if absent",
	),
);

export const vocabularySeedCommand = Command.make("vocabulary-seed").pipe(
	Command.withSubcommands([plan, apply]),
	Command.withDescription(
		"Seed an adopting repo's pipeline label vocabulary + ROADMAP.md scaffold; creates no milestones (#4341)",
	),
);
