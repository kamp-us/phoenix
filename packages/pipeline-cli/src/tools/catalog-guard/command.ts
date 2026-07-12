/**
 * The `catalog-guard` tool — `pipeline-cli catalog-guard check [--root <d>]`.
 *
 * The CI surface for CLAUDE.md's "Every dependency via `catalog:`" convention (issue
 * #2737): every dep in every workspace `package.json` must be sourced from the pnpm
 * `catalog:` (declared once in `pnpm-workspace.yaml`) or a `workspace:` ref, never a
 * hardcoded version. Enforced fail-closed so the gap can't silently re-drift into the
 * PR #535 frozen-lockfile break (`@distilled.cloud/cloudflare` hardcoded):
 *
 *   pipeline-cli catalog-guard check            # CI gate: exit non-zero on any hardcoded dep version
 *   pipeline-cli catalog-guard check --root <d> # point at a specific repo root (else: walk up for one)
 *
 * SCOPE — real workspace members plus the root: every `package.json`-bearing dir under
 * a declared workspace glob, and the root `package.json`. A genuinely unavoidable
 * non-catalog dep lives in the tool's explicit, reasoned `DEFAULT_ALLOWLIST` (empty
 * today) — never a silent tolerance. Fail-closed on zero manifests (ADR 0092). The
 * scan/IO lives in `gate.ts`; this file wires it to the CLI (the thin-CLI-over-`gate.ts`
 * idiom shared across the guards).
 *
 * With no --root the repo root is resolved by walking UP from cwd for a workspace
 * marker (so `pnpm --filter <pkg> …`, whose cwd is the package dir, scans the whole
 * repo, not just the package).
 *
 * Exit-code contract: 0 = clean, any non-zero = failure — both a gate failure (a
 * hardcoded dep version; report on stderr) and an IO failure (fs unreadable) exit
 * non-zero, undistinguished. `CheckFailed` is caught inside the handler (not at the
 * bin's run boundary) so the contract survives folding into the shared `pipeline-cli`
 * bin, which provides only `NodeServices.layer` and no per-tool catch.
 */
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "../../find-root-dir.ts";
import {type CheckFailed, checkCatalog} from "./gate.ts";

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
		"the repo root to scan package.json manifests under (default: walk up for one)",
	),
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
		yield* checkCatalog(resolveRoot(rootOpt)).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription(
		"Fail the build if any workspace package.json dep pins a hardcoded version",
	),
);

export const catalogGuardCommand = Command.make("catalog-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed gate: every package.json dep is on catalog:/workspace:, no hardcoded versions (#2737)",
	),
);
