/**
 * The `design-token-guard` tool — `pipeline-cli design-token-guard check
 * [--root <d>] [--write-baseline]` (issue #2170, ADR 0162).
 *
 * The CI surface for the first deterministic rung of the four-pillars design law: CSS
 * consumes role tokens, never raw hex / raw px / a ref to a token that does not exist.
 *
 *   pipeline-cli design-token-guard check                  # CI gate: exit non-zero on any seam break / zero scope
 *   pipeline-cli design-token-guard check --root <d>       # point at a specific repo root (else: walk up for one)
 *   pipeline-cli design-token-guard check --write-baseline # regenerate the raw-px ceilings from the current tree, then pass
 *
 * SCOPE — every `apps/web/src/**\/*.css`. The guard fails on: a var(--…) ref to a
 * token that is neither declared, runtime-injected (config externalProperties), nor
 * grandfathered (config grandfatheredMissingTokens); a hex literal outside the
 * raw-scale layer (tokens.css); a file whose raw-px (> 2px) count exceeds its ceiling;
 * or zero CSS files in scope (fail-closed, ADR 0092). The scan/IO lives in `gate.ts`;
 * this file wires it to the CLI (mirrors `readme-guard` / `fanout-guard`).
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
import {type CheckFailed, checkDesignTokens, writeBaseline} from "./gate.ts";

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
	Flag.withDescription("the repo root to scan CSS under (default: walk up for one)"),
);

const writeBaselineFlag = Flag.boolean("write-baseline").pipe(
	Flag.withDescription("regenerate the raw-px ceilings from the current tree instead of checking"),
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
	{root: rootFlag, writeBaseline: writeBaselineFlag},
	Effect.fn(function* ({root: rootOpt, writeBaseline: doWrite}) {
		const root = resolveRoot(rootOpt);
		if (doWrite) {
			yield* writeBaseline(root);
			return;
		}
		yield* checkDesignTokens(root).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription(
		"Fail the build on a raw hex / raw-px bypass or a dead var(--…) ref (the design-token seam)",
	),
);

export const designTokenGuardCommand = Command.make("design-token-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed gate: CSS consumes role tokens only — no raw hex/px, no undefined token ref (issue #2170, ADR 0162)",
	),
);
