/**
 * The `roadmap-guard` tool — `pipeline-cli roadmap-guard check [--root <d>]`.
 *
 * The CI surface for the "ROADMAP.md ↔ GitHub-milestone sync is guarded, not vigilance"
 * ruling (roadmap map #2620, founder #2628). Parses ROADMAP.md's `## Arcs`/`## Campaigns`
 * tables (the sole parsed surface) and validates them against the live milestone
 * projection, fail-closed:
 *
 *   pipeline-cli roadmap-guard check            # CI gate: exit non-zero on any I1–I4 drift
 *   pipeline-cli roadmap-guard check --root <d> # point at a specific repo root (else: walk up)
 *
 * Invariants (I1–I4, extended to campaign rows; see `roadmap-guard.ts`): I1 arc/campaign
 * pinned to an existing milestone by number (a queued arc may defer its pin); I2 exactly
 * one active arc; I3 no unclaimed open milestone; I4 fail-closed on zero scope (ADR 0092).
 *
 * The pure decision lives in `roadmap-guard.ts` (unit-tested exhaustively); the file read
 * + `gh api` milestone fetch in `gate.ts`/`github.ts`. `MilestonesLive` is baked in with
 * `Command.provide(...)` so the registered command's residual requirement is the Node
 * platform union (the registry seam, epic #994).
 *
 * Exit-code contract: 0 = clean, any non-zero = failure — a gate failure (I1–I4 drift;
 * report on stderr), an IO failure (ROADMAP.md unreadable), and a `gh`/repo failure all
 * exit non-zero, undistinguished. `CheckFailed` is caught inside the handler so the
 * contract survives folding into the shared `pipeline-cli` bin.
 */
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "../../find-root-dir.ts";
import {type CheckFailed, checkRoadmap} from "./gate.ts";
import {MilestonesLive} from "./github.ts";

const GATE_FAIL_EXIT_CODE = 1;
// Repo-root markers, in priority order: a pnpm workspace, then a VCS dir.
const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"] as const;

const defaultRoot = (from: string = process.cwd()): string => {
	const start = resolve(from);
	const root = findRootDir(
		start,
		(dir) => ROOT_MARKERS.some((marker) => existsSync(join(dir, marker))),
		dirname,
	);
	return root ?? start;
};

const rootFlag = Flag.string("root").pipe(
	Flag.optional,
	Flag.withDescription("the repo root holding ROADMAP.md (default: walk up for one)"),
);

const resolveRoot = (root: Option.Option<string>): string =>
	Option.getOrElse(root, () => defaultRoot());

// CheckFailed is the expected gate-fail signal — print its reason on stderr and exit
// non-zero WITHOUT a stack trace; genuine crashes (IoError, gh failures) still get the
// default error report (also a non-zero exit — both are failures, undistinguished).
const onCheckFailed = (e: CheckFailed) =>
	Effect.sync(() => {
		process.stderr.write(`${e.reason}\n`);
		process.exit(GATE_FAIL_EXIT_CODE);
	});

const check = Command.make(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root: rootOpt}) {
		yield* checkRoadmap(resolveRoot(rootOpt)).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription(
		"Fail the build if ROADMAP.md's arc/campaign tables have drifted from the milestone projection",
	),
);

export const roadmapGuardCommand = Command.make("roadmap-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed gate: ROADMAP.md ↔ GitHub-milestone sync (I1–I4, #2620/#2632)",
	),
	Command.provide(MilestonesLive),
);
