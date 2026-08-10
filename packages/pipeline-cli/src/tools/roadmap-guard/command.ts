/**
 * The `roadmap-guard` tool — `pipeline-cli roadmap-guard check [--root <d>]`.
 *
 * The CI surface for the "ROADMAP.md ↔ GitHub-milestone sync is guarded, not vigilance"
 * ruling (roadmap map #2620, founder #2628). Parses ROADMAP.md's
 * `## Arcs`/`## Campaigns`/`## Focus` tables (the sole parsed surface) and validates them
 * against the live milestone projection, fail-closed:
 *
 *   pipeline-cli roadmap-guard check            # CI gate: exit non-zero on any I1–I6 drift
 *   pipeline-cli roadmap-guard check --root <d> # point at a specific repo root (else: walk up)
 *
 * Invariants (I1–I6, extended to campaign rows; see `roadmap-guard.ts`): I1 arc/campaign
 * pinned to an existing milestone by number (a queued arc may defer its pin); I2 exactly
 * one active arc; I3 no unclaimed open milestone; I4 fail-closed on zero scope (ADR 0092);
 * I5 active↔done state symmetry — an active row's milestone is open, a done row's closed
 * (the campaign lifecycle guard, #2660); I6 the declared focus is at most one row over an
 * open, actively-claimed milestone (#5012 — absence and emptiness are the legal default).
 *
 * The pure decision lives in `roadmap-guard.ts` (unit-tested exhaustively); the file read
 * + `gh api` milestone fetch in `gate.ts`/`github.ts`. `MilestonesLive` is baked in with
 * `Command.provide(...)` so the registered command's residual requirement is the Node
 * platform union (the registry seam, epic #994).
 *
 * Exit-code contract: 0 = clean, any non-zero = failure — a gate failure (I1–I6 drift;
 * report on stderr), an IO failure (ROADMAP.md unreadable), and a `gh`/repo failure all
 * exit non-zero, undistinguished. `CheckFailed` is caught inside the handler so the
 * contract survives folding into the shared `pipeline-cli` bin.
 */
import {Effect, FileSystem, Option, Path} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {onCheckFailed} from "../../gate-fail.ts";
import {checkRoadmap} from "./gate.ts";
import {MilestonesLive} from "./github.ts";

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
		const root = yield* resolveRoot(rootOpt);
		yield* checkRoadmap(root).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription(
		"Fail the build if ROADMAP.md's arc/campaign tables have drifted from the milestone projection",
	),
);

export const roadmapGuardCommand = Command.make("roadmap-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed gate: ROADMAP.md ↔ GitHub-milestone sync (I1–I6, #2620/#2632/#2660/#5012)",
	),
	Command.provide(MilestonesLive),
);
