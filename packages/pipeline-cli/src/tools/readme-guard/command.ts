/**
 * The `readme-guard` tool — `pipeline-cli readme-guard check [--root <d>]`.
 *
 * The CI surface for the "every packages/* workspace package carries a README.md"
 * convention (issues #938/#939). Records the convention in the root `CLAUDE.md` and
 * enforces it fail-closed so the gap can't silently re-drift (the same drift class
 * as the schema-mirror #859 / node:sqlite #930 incidents):
 *
 *   pipeline-cli readme-guard check            # CI gate: exit non-zero if any real member lacks a README
 *   pipeline-cli readme-guard check --root <d> # point at a specific repo root (else: walk up for one)
 *
 * SCOPE — real workspace members only: a `packages/*` dir counts only when it holds
 * a `package.json`. Bare directories (the #1003 consolidation's dead shells, tracked
 * for removal by #1351) are ignored, so the guard reds on a real README gap, not on
 * leftover litter. The scope is grounded in `pnpm-workspace.yaml`'s `packages/*`
 * glob. Fail-closed on zero members (ADR 0092). The scan/IO lives in `gate.ts`; this
 * file wires it to the CLI (the thin-CLI-over-`gate.ts` idiom shared across the guards).
 *
 * With no --root the repo root is resolved by walking UP from cwd for a workspace
 * marker (so `pnpm --filter <pkg> …`, whose cwd is the package dir, scans the whole
 * repo, not just the package).
 *
 * Exit-code contract: 0 = clean, any non-zero = failure — both a gate failure (a
 * member without a README; report on stderr) and an IO failure (fs unreadable) exit
 * non-zero, undistinguished. `CheckFailed` is caught inside the handler (not at the
 * bin's run boundary) so the contract survives folding into the shared `pipeline-cli`
 * bin, which provides only `NodeServices.layer` and no per-tool catch.
 */
import {Effect, FileSystem, Option, Path} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {onCheckFailed} from "../../gate-fail.ts";
import {checkReadmes} from "./gate.ts";

// Repo-root markers, in priority order: a pnpm workspace, then a VCS dir.
const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"] as const;

// Walk up from cwd for the first ancestor bearing a repo-root marker, probing each
// marker through the `FileSystem`/`Path` seam so the resolver is testable off real
// disk (.patterns/effect-platform-access.md). A marker-existence fault falls through as
// false, matching the old `existsSync`; the walk falls back to the start on no hit.
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
	Flag.withDescription("the repo root to scan packages/* under (default: walk up for one)"),
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
		yield* checkReadmes(root).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription("Fail the build if any packages/* workspace member lacks a README.md"),
);

export const readmeGuardCommand = Command.make("readme-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed gate: every packages/* workspace package carries a README.md (#938/#939)",
	),
);
