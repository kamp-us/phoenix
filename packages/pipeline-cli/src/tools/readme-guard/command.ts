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
 * file wires it to the CLI (mirrors `doc-links`).
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
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "../doc-links/doc-links.ts";
import {type CheckFailed, checkReadmes} from "./gate.ts";

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
	Flag.withDescription("the repo root to scan packages/* under (default: walk up for one)"),
);

const resolveRoot = (root: Option.Option<string>): string =>
	Option.getOrElse(root, () => defaultRoot());

// CheckFailed is the expected gate-fail signal — print its reason on stderr and exit
// non-zero WITHOUT a stack trace; genuine crashes (IoError, etc.) still get the
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
		yield* checkReadmes(resolveRoot(rootOpt)).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
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
