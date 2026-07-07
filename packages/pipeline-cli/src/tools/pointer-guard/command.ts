/**
 * The `pointer-guard` tool — `pipeline-cli pointer-guard check [--root <d>]`.
 *
 * The CI surface for the fail-closed stale-pointer gate over `**​/CLAUDE.md` (#988):
 *
 *   pipeline-cli pointer-guard check            # CI gate: exit non-zero on any stale CLAUDE.md pointer
 *   pipeline-cli pointer-guard check --root <d> # point at a specific repo root (else: walk up for one)
 *
 * `doc-links` (#638) validates markdown `[text](path)` links and masks code spans;
 * this gate reads the *other* reference class — backticked repo-root-relative path
 * pointers in CLAUDE.md prose ("operate from the repo root, never `apps/web`") that
 * rot when a file is renamed and that `doc-links` masks by construction. Scope and
 * the precision-over-recall path-likeness filter live in `pointer-guard.ts`; the
 * scan/IO lives in `gate.ts`; this file wires it to the CLI (mirrors `doc-links` /
 * `readme-guard`).
 *
 * With no --root the repo root is resolved by walking UP from cwd for a workspace
 * marker (so `pnpm --filter <pkg> …`, whose cwd is the package dir, scans the whole
 * repo, not just the package — same fix as decisions-index #447).
 *
 * Exit-code contract: 0 = clean, any non-zero = failure — both a gate failure (a
 * stale pointer; report on stderr) and an IO failure (git/fs unreadable) exit
 * non-zero, undistinguished. `CheckFailed` is caught inside the handler (not at the
 * bin's run boundary) so the contract survives folding into the shared `pipeline-cli`
 * bin, which provides only `NodeServices.layer` and no per-tool catch.
 */
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "../../find-root-dir.ts";
import {type CheckFailed, checkPointers} from "./gate.ts";

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
	Flag.withDescription("the repo root to scan CLAUDE.md files under (default: walk up for one)"),
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
		yield* checkPointers(resolveRoot(rootOpt)).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(Command.withDescription("Fail the build if any backticked CLAUDE.md path pointer is stale"));

export const pointerGuardCommand = Command.make("pointer-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed gate: backticked repo-path pointers in CLAUDE.md resolve (#988)",
	),
);
