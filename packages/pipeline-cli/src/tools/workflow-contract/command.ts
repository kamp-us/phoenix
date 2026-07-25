/**
 * The `workflow-contract` tool — `pipeline-cli workflow-contract check [--root <d>]`.
 *
 * The CI surface for the Workflow-script contract gate (#1219). Bug #1217 was a
 * `.claude/workflows/*.js` that cleared `node --check` (valid ES-module syntax) and
 * `review-code` (correct logic) yet was NON-LAUNCHABLE — it carried an `export
 * default` wrapper the Workflow runtime rejects (`SyntaxError: Unexpected keyword
 * 'export'`), failing only at the first live `Workflow({ scriptPath })`. This guard
 * closes that blind spot: it asserts each workflow script against the runtime's load
 * shape so a mis-shaped one fails at REVIEW, not at live-drive.
 *
 *   pipeline-cli workflow-contract check            # CI gate: exit non-zero on a contract violation
 *   pipeline-cli workflow-contract check --root <d> # point at a specific repo root (else: walk up for one)
 *
 * Fail-closed (ADR 0092): a present-but-unparseable or violating script reds; an
 * empty set (no `.claude/workflows/*.js`) passes clean. The contract + parse live in
 * `workflow-contract.ts`; the scan/IO in `gate.ts`; this file wires it to the CLI
 * (mirrors `readme-guard`).
 *
 * With no --root the repo root is resolved by walking UP from cwd for a workspace
 * marker (so `pnpm --filter <pkg> …`, whose cwd is the package dir, scans the whole
 * repo, not just the package).
 *
 * Exit-code contract: 0 = clean, any non-zero = failure — both a gate failure (a
 * contract violation; report on stderr) and an IO failure (fs unreadable) exit
 * non-zero, undistinguished. `CheckFailed` is caught inside the handler (not at the
 * bin's run boundary) so the contract survives folding into the shared `pipeline-cli`
 * bin, which provides only `NodeServices.layer` and no per-tool catch.
 */
import {Effect, FileSystem, Option, Path} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {type CheckFailed, checkWorkflows} from "./gate.ts";

const GATE_FAIL_EXIT_CODE = 1;
// Repo-root markers, in priority order: a pnpm workspace, then a VCS dir.
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
	Flag.withDescription(
		"the repo root to scan .claude/workflows/*.js under (default: walk up for one)",
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
		yield* checkWorkflows(root).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription(
		"Fail the build if any .claude/workflows/*.js violates the Workflow runtime contract",
	),
);

export const workflowContractCommand = Command.make("workflow-contract").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed gate: every .claude/workflows/*.js conforms to the Workflow runtime load shape (#1219)",
	),
);
