/**
 * The `doc-links` tool — `pipeline-cli doc-links check [--root <d>]`.
 *
 * The CI surface for the repo-wide dead-internal-link gate (#638), moved into the
 * pipeline-cli registry (epic #994, Phase 2 / #999):
 *
 *   pipeline-cli doc-links check            # CI gate: exit non-zero on any dead internal doc link
 *   pipeline-cli doc-links check --root <d> # point at a specific repo root (else: walk up for one)
 *
 * `review-doc` is PR-scoped, so a file rename/delete only orphans links in docs
 * *outside* that PR's diff and nothing re-checks the rest of the tree. This gate
 * closes that gap: it walks every git-tracked `.md` and fails the build if a
 * relative/internal link points at a path that no longer resolves on disk. External
 * links (`http(s):`, `mailto:`) and links inside code spans/fences are skipped —
 * see `doc-links.ts`. The scan/IO lives in `gate.ts`; this file wires it to the CLI.
 *
 * With no --root the repo root is resolved by walking UP from cwd for a workspace
 * marker (so `pnpm --filter <pkg> …`, whose cwd is the package dir, scans the
 * whole repo, not just the package — same fix as decisions-index #447).
 *
 * Exit-code contract (preserved from the package's former `bin.ts`): 0 = clean,
 * any non-zero = failure — both a gate failure (a dead link; report on stderr)
 * and an IO failure (e.g. git/fs unreadable) exit non-zero, undistinguished.
 * `CheckFailed` is caught inside the handler (not at the bin's run boundary) so
 * the contract survives folding into the shared `pipeline-cli` bin, which provides
 * only `NodeServices.layer` and no per-tool catch.
 */
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "./doc-links.ts";
import type {CheckFailed} from "./gate.ts";
import {checkLinks} from "./gate.ts";

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
	Flag.withDescription(
		"the repo root to scan git-tracked .md files under (default: walk up for one)",
	),
);

const resolveRoot = (root: Option.Option<string>): string =>
	Option.getOrElse(root, () => defaultRoot());

// CheckFailed is the expected gate-fail signal — print its reason on stderr and exit
// non-zero WITHOUT a stack trace; genuine crashes (IoError, etc.) still get the
// default error report (also a non-zero exit — both are failures, undistinguished).
const onCheckFailed = (e: CheckFailed) =>
	Effect.sync(() => {
		process.stderr.write(`doc-links: ${e.reason}\n`);
		process.exit(GATE_FAIL_EXIT_CODE);
	});

const check = Command.make(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root: rootOpt}) {
		yield* checkLinks(resolveRoot(rootOpt)).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(Command.withDescription("Fail the build if any internal doc link is dead"));

export const docLinksCommand = Command.make("doc-links").pipe(
	Command.withSubcommands([check]),
	Command.withDescription("Repo-wide dead-internal-link gate for docs (#638)"),
);
