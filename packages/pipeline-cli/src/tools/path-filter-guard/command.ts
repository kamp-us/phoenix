/**
 * The `path-filter-guard` tool — `pipeline-cli path-filter-guard check [--root <d>]`
 * (issue #2372).
 *
 * The CI surface for "ci.yml's `changes.e2e` path-filter and deploy.yml's `changes.deploy`
 * path-filter must stay the same set". The two lists pin the deploy⊇e2e sync invariant
 * (deploy skips only where e2e also skips); it held only by a reciprocal human comment,
 * so a future edit to one could silently drift the other and wedge `ci-required` via
 * e2e's timed-out preview-comment poll. This guard makes the invariant mechanical:
 *
 *   pipeline-cli path-filter-guard check            # CI gate: exit non-zero on drift / zero scope
 *   pipeline-cli path-filter-guard check --root <d> # point at a specific repo root (else: walk up for one)
 *
 * The scan/IO lives in `gate.ts`; this file wires it to the CLI (mirrors `readme-guard`/
 * `fanout-guard`).
 *
 * Exit-code contract: 0 = clean, any non-zero = failure — a gate failure (report on
 * stderr) and an IO failure exit non-zero, undistinguished. `CheckFailed` is caught
 * inside the handler (not at the bin's run boundary) so the contract survives folding
 * into the shared `pipeline-cli` bin, which provides only `NodeServices.layer`.
 */
import {Effect, FileSystem, Option, Path} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {onCheckFailed} from "../../gate-fail.ts";
import {checkPathFilters} from "./gate.ts";

const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"] as const;

// Walk up from cwd for the first ancestor bearing a repo-root marker, probing each marker
// through the `FileSystem`/`Path` seam so the resolver is testable off real disk
// (.patterns/effect-platform-access.md). Marker-existence faults fall through as false,
// matching the prior `existsSync`.
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
	Flag.withDescription(
		"the repo root to read the two workflow files under (default: walk up for one)",
	),
);

const resolveRoot = (
	root: Option.Option<string>,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
	Option.match(root, {onNone: () => defaultRoot(), onSome: Effect.succeed});

const check = Command.make(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root: rootOpt}) {
		const root = yield* resolveRoot(rootOpt);
		yield* checkPathFilters(root).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription(
		"Fail the build if ci.yml's changes.e2e and deploy.yml's changes.deploy path-filter sets drift apart",
	),
);

export const pathFilterGuardCommand = Command.make("path-filter-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed gate: ci.yml changes.e2e and deploy.yml changes.deploy stay the same path set (#2372)",
	),
);
