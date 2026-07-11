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
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "../../find-root-dir.ts";
import {type CheckFailed, checkSettingsEnv} from "./gate.ts";

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
		"the repo root whose .claude/settings.json to scan (default: walk up for one)",
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
		yield* checkSettingsEnv(resolveRoot(rootOpt)).pipe(
			Effect.catchTag("CheckFailed", onCheckFailed),
		);
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
