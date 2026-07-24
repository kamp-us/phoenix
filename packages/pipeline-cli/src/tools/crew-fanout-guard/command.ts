/**
 * The `crew-fanout-guard` tool — `pipeline-cli crew-fanout-guard check [--root <d>]`.
 *
 * The CI surface for #3606: assert every mutating roster agent-type is EXPLICITLY CLASSIFIED
 * — allowlisted or out-of-scope — for each of the three crew bridges (chief-of-staff /
 * cartographer / intake-desk under `claude-plugins/pipeline-crew/agents/`), so a FUTURE
 * mutating agent-type added to the roster reds the build, closing the "a future reader
 * silently reopens the deleted edge" hole ADR 0196 warns about (roster-law boundary, ADR
 * 0189/0196). The classification lives in the pure core's own tables, not in the defs — see
 * `crew-fanout-guard.ts` for why the old def-`disallowedTools` reading was a non-mechanism
 * (#3764):
 *
 *   pipeline-cli crew-fanout-guard check            # CI gate: exit non-zero on an unclassified agent-type
 *   pipeline-cli crew-fanout-guard check --root <d> # point at a specific repo root (else: walk up for one)
 *
 * Fail-closed on zero scope, a missing bridge def, a stale classification, or any
 * unclassified bridge×agent-type pair (ADR 0092). The scan/IO lives in `gate.ts`; this file
 * wires it to the CLI (the thin-CLI-over-`gate.ts` idiom shared across the guards).
 *
 * Exit-code contract: 0 = clean, any non-zero = failure — both a gate failure (report on
 * stderr) and an IO failure (fs unreadable) exit non-zero, undistinguished. `CheckFailed`
 * is caught inside the handler (not at the bin's run boundary) so the contract survives
 * folding into the shared `pipeline-cli` bin, which provides only `NodeServices.layer`.
 */
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "../../find-root-dir.ts";
import {type CheckFailed, checkCrewFanout} from "./gate.ts";

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
		"the repo root to scan the crew agent defs under (default: walk up for one)",
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
		yield* checkCrewFanout(resolveRoot(rootOpt)).pipe(
			Effect.catchTag("CheckFailed", onCheckFailed),
		);
	}),
).pipe(
	Command.withDescription(
		"Fail the build if a crew bridge fails to deny a non-allowlisted mutating roster agent-type",
	),
);

export const crewFanoutGuardCommand = Command.make("crew-fanout-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed gate: every crew bridge denies every non-allowlisted mutating roster agent-type (#3606, ADR 0189/0196)",
	),
);
