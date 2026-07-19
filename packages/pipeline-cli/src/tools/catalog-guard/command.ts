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
import {Effect, FileSystem, Option, Path} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {type CheckFailed, checkCatalog} from "./gate.ts";

const GATE_FAIL_EXIT_CODE = 1;
// Repo-root markers, in priority order: a pnpm workspace, then a VCS dir.
const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"] as const;

// Walk up from cwd for the first ancestor bearing a repo-root marker, probing each
// marker through the `FileSystem`/`Path` seam so the resolver is testable off real
// disk (.patterns/effect-platform-access.md). Mirrors `findRootDir`'s pure upward walk
// (dirname to the fixpoint, then fall back to the start), but the marker check is the
// fs seam — `fs.exists` yields an Effect, so the walk lives here rather than in the
// pure helper. Marker-existence faults fall through as false, matching `existsSync`.
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
		"the repo root to scan package.json manifests under (default: walk up for one)",
	),
);

const resolveRoot = (
	root: Option.Option<string>,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
	Option.match(root, {onNone: () => defaultRoot(), onSome: Effect.succeed});

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
		const root = yield* resolveRoot(rootOpt);
		yield* checkCatalog(root).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
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
