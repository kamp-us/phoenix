/**
 * The `fanout-guard` tool — `pipeline-cli fanout-guard check [--root <d>]` (ADR 0155).
 *
 * The CI surface for "a mutation over a fanned entity must publish the /fate/live
 * invalidation". Backed by the declared manifest
 * (`apps/web/worker/features/fate-live/fanned-mutations.ts`), it enforces two things
 * fail-closed so the #1893–#1896 silent-omission class can't re-drift:
 *
 *   pipeline-cli fanout-guard check            # CI gate: exit non-zero on drift / a fanned mutation with no publish / zero scope
 *   pipeline-cli fanout-guard check --root <d> # point at a specific repo root (else: walk up for one)
 *
 * SCOPE — every `Fate.mutation` under `apps/web/worker/features/*.mutations.ts`. The
 * guard fails on: a discovered mutation with no manifest row (drift, forcing the
 * conscious fanned/not decision), a manifest row for a mutation that no longer exists
 * (stale), a `fanned: true` mutation whose feature omits a `WorkerLivePublisher`
 * publish, or zero discovered mutations (fail-closed, ADR 0092). The scan/IO lives in
 * `gate.ts`; this file wires it to the CLI (mirrors `readme-guard`).
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
import {type CheckFailed, checkFanout} from "./gate.ts";

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
	Flag.withDescription("the repo root to scan worker mutations under (default: walk up for one)"),
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
		yield* checkFanout(resolveRoot(rootOpt)).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription(
		"Fail the build if a fanned mutation omits the /fate/live publish, or a mutation is unclassified",
	),
);

export const fanoutGuardCommand = Command.make("fanout-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed gate: every fanned mutation publishes its /fate/live invalidation (ADR 0155, #1898)",
	),
);
