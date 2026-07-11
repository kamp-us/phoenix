/**
 * The `reachability-guard` tool — `pipeline-cli reachability-guard check <flag-key> [--root <d>]`
 * (ADR 0173).
 *
 * The one shared reachability contract both `plan-epic` (#2530) and `/release` (#2531)
 * key off — a flag can't graduate to 100% while its vertical's user-facing slice is
 * unbuilt:
 *
 *   pipeline-cli reachability-guard check <flag-key>            # exit non-zero if the flag is unreachable
 *   pipeline-cli reachability-guard check <flag-key> --root <d> # point at a specific repo root
 *
 * SCOPE — the flag-key module `apps/web/src/flags/keys.ts`, the SPA `.tsx` source under
 * `apps/web/src`, and the e2e specs under `apps/web/tests/e2e`. The guard fails on: a
 * user-facing flag with no consuming `.tsx` and/or no `@journey:<flag-key>`-tagged e2e
 * (unreachable), an unknown/unclassified flag key, or zero parsed flag definitions
 * (fail-closed, ADR 0092). A UI-less infra flag opts out with `@reachability-exempt:
 * <reason>` at its keys.ts definition. The scan/IO lives in `gate.ts`; this file wires it
 * to the CLI (mirrors `fanout-guard`).
 *
 * With no --root the repo root is resolved by walking UP from cwd for a workspace marker
 * (so `pnpm --filter <pkg> …`, whose cwd is the package dir, scans the whole repo).
 *
 * Exit-code contract: 0 = reachable/exempt, any non-zero = failure — both a gate failure
 * (report on stderr) and an IO failure exit non-zero, undistinguished. `CheckFailed` is
 * caught inside the handler (not at the bin's run boundary) so the contract survives
 * folding into the shared `pipeline-cli` bin, which provides only `NodeServices.layer`.
 */
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "../../find-root-dir.ts";
import {type CheckFailed, checkReachability} from "./gate.ts";

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

const flagKeyArg = Argument.string("flag-key").pipe(
	Argument.withDescription("the Flagship flag key to assert reachable (e.g. phoenix-reactions)"),
);

const rootFlag = Flag.string("root").pipe(
	Flag.optional,
	Flag.withDescription("the repo root to scan flags/UI/e2e under (default: walk up for one)"),
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
	{flagKey: flagKeyArg, root: rootFlag},
	Effect.fn(function* ({flagKey, root: rootOpt}) {
		yield* checkReachability(resolveRoot(rootOpt), flagKey).pipe(
			Effect.catchTag("CheckFailed", onCheckFailed),
		);
	}),
).pipe(
	Command.withDescription(
		"Fail if a flag is unreachable — no consuming UI and/or no registered journey e2e",
	),
);

export const reachabilityGuardCommand = Command.make("reachability-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed gate: a flag can't graduate while its user-facing slice is unbuilt (ADR 0173, #2529)",
	),
);
