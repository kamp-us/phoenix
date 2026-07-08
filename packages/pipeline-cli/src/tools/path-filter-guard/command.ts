/**
 * The `path-filter-guard` tool — `pipeline-cli path-filter-guard check [--root <d>]`
 * (issue #2372).
 *
 * The CI surface for "ci.yml's `changes.e2e` path-filter and deploy.yml's `changes.deploy`
 * path-filter must stay the same set". The two lists pin the deploy⊇e2e sync invariant
 * (deploy skips only where e2e also skips); it held only by a reciprocal human comment,
 * so a future edit to one could silently drift the other and wedge `ci-required` via
 * e2e's timed-out preview-comment poll. This guard makes the invariant mechanical:
 *
 *   pipeline-cli path-filter-guard check            # CI gate: exit non-zero on drift / zero scope
 *   pipeline-cli path-filter-guard check --root <d> # point at a specific repo root (else: walk up for one)
 *
 * The scan/IO lives in `gate.ts`; this file wires it to the CLI (mirrors `readme-guard`/
 * `fanout-guard`).
 *
 * Exit-code contract: 0 = clean, any non-zero = failure — a gate failure (report on
 * stderr) and an IO failure exit non-zero, undistinguished. `CheckFailed` is caught
 * inside the handler (not at the bin's run boundary) so the contract survives folding
 * into the shared `pipeline-cli` bin, which provides only `NodeServices.layer`.
 */
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "../../find-root-dir.ts";
import {type CheckFailed, checkPathFilters} from "./gate.ts";

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
		"the repo root to read the two workflow files under (default: walk up for one)",
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
		yield* checkPathFilters(resolveRoot(rootOpt)).pipe(
			Effect.catchTag("CheckFailed", onCheckFailed),
		);
	}),
).pipe(
	Command.withDescription(
		"Fail the build if ci.yml's changes.e2e and deploy.yml's changes.deploy path-filter sets drift apart",
	),
);

export const pathFilterGuardCommand = Command.make("path-filter-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed gate: ci.yml changes.e2e and deploy.yml changes.deploy stay the same path set (#2372)",
	),
);
