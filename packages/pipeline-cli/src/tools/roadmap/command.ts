/**
 * The `roadmap` tool — `pipeline-cli roadmap view [--root <d>]`.
 *
 * The observability surface of the steering seam (#2639 part 3, roadmap map #2620): a read-only
 * view that renders the roadmap work-tree top-down — arcs → milestones → epic trees → open PRs —
 * from ROADMAP.md's `## Arcs`/`## Campaigns` tables (the sole parsed roadmap surface) joined to the
 * live GitHub milestone/issue/PR projection, and flags stale p1s (open p1s outside the active-arc
 * milestone) as drift:
 *
 *   pipeline-cli roadmap view            # render the tree + stale-p1 drift to stdout
 *   pipeline-cli roadmap view --root <d> # point at a specific repo root (else: walk up)
 *
 * READ-ONLY: it mutates nothing (no labels, milestones, or issue/PR writes). It is distinct from
 * `roadmap-guard`, which owns the fail-closed ROADMAP.md ↔ milestone sync enforcement — this view
 * owns human-legible display. All GitHub reads go through `gh api` REST, never GraphQL (the org's
 * legacy Projects-classic integration errors GraphQL issue/PR queries).
 *
 * The pure decision lives in `roadmap.ts` (unit-tested exhaustively); the file read + `gh api`
 * fetch in `view.ts`/`github.ts`. `GithubLive` is baked in with `Command.provide(...)` so the
 * registered command's residual requirement is the Node platform union (the registry seam, #994).
 */
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "../../find-root-dir.ts";
import {GithubLive} from "./github.ts";
import {renderRoadmap} from "./view.ts";

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

const view = Command.make(
	"view",
	{root: rootFlag},
	Effect.fn(function* ({root: rootOpt}) {
		yield* renderRoadmap(resolveRoot(rootOpt));
	}),
).pipe(
	Command.withDescription(
		"Render the roadmap tree (arcs → milestones → epic trees → open PRs) + stale-p1 drift to stdout",
	),
);

export const roadmapCommand = Command.make("roadmap").pipe(
	Command.withSubcommands([view]),
	Command.withDescription(
		"Read-only roadmap view: arcs → milestones → epic trees → open PRs, flagging stale p1s (#2639/#2651)",
	),
	Command.provide(GithubLive),
);
