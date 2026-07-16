/**
 * The `patch-guard` tool — `pipeline-cli patch-guard check [--root <d>]` (ADR 0038).
 *
 * The CI surface for the epic's forcing function: a `pnpm patch` cannot land without a
 * registered behavior-pinning test. It reads the `patchedDependencies` map from
 * `pnpm-workspace.yaml` (the authoritative maintained-patch set) and the
 * `// @patch-pin: <name>@<version>` markers across the test tree, and enforces the
 * two-layer discipline fail-closed:
 *
 *   pipeline-cli patch-guard check            # CI gate: exit non-zero on an unpinned patch / a stale pin / zero scope
 *   pipeline-cli patch-guard check --root <d> # point at a specific repo root (else: walk up for one)
 *
 * SCOPE — every key in `patchedDependencies`, cross-checked against every `@patch-pin:`
 * marker in a `*.test.ts(x)` file. The guard fails on: a patched dep with no matching
 * pin marker, a marker naming a dep/version not in `patchedDependencies` (stale pin), or
 * zero patchedDependencies in scope (fail-closed, ADR 0092). The marker grammar + the
 * two-layer discipline (version-keyed loud-fail + behavior pin) are defined in
 * `.patterns/dependency-patch-behavior-pins.md`. The scan/IO lives in `gate.ts`; this
 * file wires it to the CLI (the thin-CLI-over-`gate.ts` idiom shared across the guards).
 *
 * With no --root the repo root is resolved by walking UP from cwd for a workspace
 * marker (so `pnpm --filter <pkg> …`, whose cwd is the package dir, scans the whole
 * repo, not just the package).
 *
 * Exit-code contract: 0 = clean, any non-zero = failure — both a gate failure (report
 * on stderr) and an IO failure exit non-zero, undistinguished. `CheckFailed` is caught
 * inside the handler (not at the bin's run boundary) so the contract survives folding
 * into the shared `pipeline-cli` bin, which provides only `NodeServices.layer`.
 */
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "../../find-root-dir.ts";
import {type CheckFailed, checkPatchGuard} from "./gate.ts";

const GATE_FAIL_EXIT_CODE = 1;
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
		"the repo root to scan patchedDependencies + pins under (default: walk up for one)",
	),
);

const resolveRoot = (root: Option.Option<string>): string =>
	Option.getOrElse(root, () => defaultRoot());

// CheckFailed is the expected gate-fail signal — print its reason on stderr and exit
// non-zero WITHOUT a stack trace; genuine crashes (IoError, etc.) still get the default
// error report (also a non-zero exit — both are failures, undistinguished).
const onCheckFailed = (e: CheckFailed) =>
	Effect.sync(() => {
		process.stderr.write(`${e.reason}\n`);
		process.exit(GATE_FAIL_EXIT_CODE);
	});

const check = Command.make(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root: rootOpt}) {
		yield* checkPatchGuard(resolveRoot(rootOpt)).pipe(
			Effect.catchTag("CheckFailed", onCheckFailed),
		);
	}),
).pipe(
	Command.withDescription(
		"Fail the build if a maintained pnpm patch has no @patch-pin behavior test, or a pin is stale",
	),
);

export const patchGuardCommand = Command.make("patch-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed gate: every pnpm patch (ADR 0038) carries a registered behavior-pinning test (#3051)",
	),
);
