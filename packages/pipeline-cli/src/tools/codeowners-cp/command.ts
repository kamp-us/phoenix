/**
 * The `codeowners-cp` tool — `pipeline-cli codeowners-cp check [--root <d>]`.
 *
 *   pipeline-cli codeowners-cp check            # CI gate: exit non-zero if a §CP path is unowned
 *   pipeline-cli codeowners-cp check --root <d> # point at a specific repo root (else: walk up)
 *
 * The §CP control-plane set is the live `CONTROL_PLANE_RE` (a pattern), but
 * `.github/CODEOWNERS` enumerates the same paths literally — the two drift silently,
 * leaving a §CP path control-plane-by-regex yet outside `require_code_owner_review`
 * (under-protected; #934/#953). This gate reads the §CP set FROM the canonical regex
 * and fails the build when any §CP path lacks a covering CODEOWNERS row. The scan/IO
 * lives in `gate.ts`; this file wires it to the CLI.
 *
 * Exit-code contract (mirrors readme-guard): 0 = in sync, any non-zero = failure — both
 * a gate failure (an unowned §CP path / unparseable source / zero-scope; reason on
 * stderr) and a genuine IO crash exit non-zero, undistinguished. `CheckFailed` is
 * caught inside the handler (not at the bin's run boundary) so the contract survives
 * folding into the shared `pipeline-cli` bin, which provides only `NodeServices.layer`.
 */
import {Effect, type FileSystem, Option, type Path} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {onCheckFailedWithPrefix} from "../../gate-fail.ts";
import {checkCodeownersCp, defaultRoot} from "./gate.ts";

const onCheckFailed = onCheckFailedWithPrefix("codeowners-cp: ");

const rootFlag = Flag.string("root").pipe(
	Flag.optional,
	Flag.withDescription(
		"the repo root to read CONTROL_PLANE_RE + CODEOWNERS under (default: walk up)",
	),
);

const resolveRoot = (
	root: Option.Option<string>,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
	Option.match(root, {onNone: () => defaultRoot(), onSome: Effect.succeed});

const check = Command.make(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root: rootOpt}) {
		const root = yield* resolveRoot(rootOpt);
		yield* checkCodeownersCp(root).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription("Fail the build if a §CP control-plane path has no CODEOWNERS owner"),
);

export const codeownersCpCommand = Command.make("codeowners-cp").pipe(
	Command.withSubcommands([check]),
	Command.withDescription("§CP CONTROL_PLANE_RE ↔ .github/CODEOWNERS drift gate (#955)"),
);
