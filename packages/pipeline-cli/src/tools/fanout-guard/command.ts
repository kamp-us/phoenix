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
import {Effect, FileSystem, Option, Path} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {type CheckFailed, checkFanout} from "./gate.ts";

const GATE_FAIL_EXIT_CODE = 1;
const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"] as const;

// Walk up from cwd for the first ancestor bearing a repo-root marker, probing each marker
// through the `FileSystem`/`Path` seam so the resolver is testable off real disk
// (.patterns/effect-platform-access.md). Marker-existence faults fall through as false,
// matching the prior `existsSync`.
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
	Flag.withDescription("the repo root to scan worker mutations under (default: walk up for one)"),
);

const resolveRoot = (
	root: Option.Option<string>,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
	Option.match(root, {onNone: () => defaultRoot(), onSome: Effect.succeed});

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
		const root = yield* resolveRoot(rootOpt);
		yield* checkFanout(root).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
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
