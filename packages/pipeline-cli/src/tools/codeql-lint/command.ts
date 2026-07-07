/**
 * The `codeql-lint` tool — `pipeline-cli codeql-lint check [--root <d>]` (issue #2261).
 *
 * The author-time (pre-push) shift-left for the two COMMON CodeQL findings that keep
 * blocking net-new-artifact PRs at ship — never at `review-code`, which does not run
 * CodeQL: a workflow missing a least-privilege `permissions:` block (PR #2251) and a
 * regex with catastrophic backtracking (ReDoS, PR #2258). It is a deterministic local
 * static check — NO network, NO CodeQL — that catches the common shapes cheaply so the
 * fix lands before CI, not after a full repair → re-review → re-ship cycle.
 *
 *   pipeline-cli codeql-lint check              # gate: exit non-zero on any finding / zero scope
 *   pipeline-cli codeql-lint check --root <d>   # point at a specific repo root (else: walk up for one)
 *
 * The scan/IO lives in `gate.ts` and the decision in the pure core `codeql-lint.ts`;
 * this file wires them to the CLI (mirrors `design-token-guard` / `fanout-guard`). With
 * no --root the repo root is resolved by walking UP from cwd for a workspace marker (so
 * `pnpm --filter <pkg> …`, whose cwd is the package dir, scans the whole repo).
 *
 * Exit-code contract (a DEDICATED gate-fail code, like `leak-guard` = 2 / `ref-guard` = 3):
 *   0 = clean; 2 = a real finding (a workflow missing permissions / a catastrophic regex);
 *   any OTHER non-zero (1, 127, the #1798 unlinked-dep remediation) = the check could not
 *   RUN. The pre-push hook keys off code 2 to fail-CLOSED on a finding but fail-OPEN on an
 *   absent toolchain — so a lean/stripped-PATH worktree is never bricked (CodeQL at CI/ship
 *   remains the backstop). `CheckFailed` is caught inside the handler (not at the bin's run
 *   boundary) so the contract survives folding into the shared `pipeline-cli` bin, which
 *   provides only `NodeServices.layer`.
 */
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "../doc-links/doc-links.ts";
import {type CheckFailed, checkCodeqlLint} from "./gate.ts";

// Dedicated gate-fail code (distinct from an infra/IO failure) so the pre-push hook can
// fail-closed on a finding yet fail-open when the check can't run — see the exit-code
// contract above (the leak-guard=2 / ref-guard=3 idiom).
const GATE_FAIL_EXIT_CODE = 2;
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
	Flag.withDescription("the repo root to scan (default: walk up for a workspace marker)"),
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
		const root = resolveRoot(rootOpt);
		yield* checkCodeqlLint(root).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription(
		"Fail on a workflow missing least-privilege permissions or a catastrophic-backtracking regex (the two common CodeQL shapes, author-time)",
	),
);

export const codeqlLintCommand = Command.make("codeql-lint").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed pre-push gate: shift-left the two common CodeQL findings (workflow-permissions + ReDoS) to author time (issue #2261)",
	),
);
