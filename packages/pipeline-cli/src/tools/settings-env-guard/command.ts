/**
 * The `settings-env-guard` tool — `pipeline-cli settings-env-guard check [--root <d>]`.
 *
 * The CI surface for the #2495 invariant: no `.claude/settings.json` `env` value may
 * carry an unexpanded `${...}` token, because Claude Code applies env values verbatim
 * (no `${VAR}` expansion) — so such a value never resolves and instead creates a
 * literal-token directory or clobbers PATH (the stray `${CLAUDE_PROJECT_DIR}` dir).
 * Enforced fail-closed so the class can't silently re-drift.
 *
 *   pipeline-cli settings-env-guard check            # CI gate: exit non-zero on any ${...} in an env value
 *   pipeline-cli settings-env-guard check --root <d> # point at a specific repo root (else: walk up for one)
 *
 * The scan/IO lives in `gate.ts`; this file wires it to the CLI (the thin-CLI-over-
 * `gate.ts` idiom shared across the guards). Exit-code contract mirrors readme-guard:
 * 0 = clean, any non-zero = failure (a `${...}` offender OR an unreadable settings
 * file, undistinguished). `CheckFailed` is caught inside the handler (not at the
 * bin's run boundary) so the contract survives folding into the shared bin.
 */
import {Effect, FileSystem, Option, Path} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {type CheckFailed, checkSettingsEnv} from "./gate.ts";

const GATE_FAIL_EXIT_CODE = 1;
// Repo-root markers, in priority order: a pnpm workspace, then a VCS dir.
const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"] as const;

// Walk up from cwd for the first ancestor bearing a repo-root marker, probing each marker
// through the `FileSystem`/`Path` seam so the resolver is testable off real disk
// (.patterns/effect-platform-access.md). Mirrors `findRootDir`'s pure upward walk (dirname to
// the fixpoint, then fall back to the start), but the marker check is the fs seam — `fs.exists`
// yields an Effect. Marker-existence faults fall through as false, matching `existsSync`.
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
		"the repo root whose .claude/settings.json to scan (default: walk up for one)",
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
		yield* checkSettingsEnv(root).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription(
		"Fail the build if any .claude/settings.json env value carries an unexpanded brace token",
	),
);

export const settingsEnvGuardCommand = Command.make("settings-env-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed gate: no .claude/settings.json env value carries an unexpanded brace token (#2495)",
	),
);
