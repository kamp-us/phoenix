/**
 * The `change-detect-guard` tool — `pipeline-cli change-detect-guard check [--root <d>]`
 * (#3245).
 *
 * The CI surface for "ci.yml's `changes` job runs API-free git-mode change detection". The
 * dorny/paths-filter step gates the cost-bearing jobs and, on a `pull_request` event, reads
 * the changed-file set via the GitHub REST API (`pulls.listFiles`) unless `token: ''` forces
 * a pure `git diff`. That live API read is the sole flake surface of the step: a transient
 * GitHub-API-HTML blip reddens the whole `ci-required` aggregate on a defect-free PR. This
 * guard makes the API-free posture mechanical so it can't silently regress:
 *
 *   pipeline-cli change-detect-guard check            # CI gate: exit non-zero on API mode / zero scope
 *   pipeline-cli change-detect-guard check --root <d> # point at a specific repo root (else: walk up for one)
 *
 * The scan/IO lives in `gate.ts`; this file wires it to the CLI (mirrors `path-filter-guard`/
 * `readme-guard`/`fanout-guard`).
 *
 * Exit-code contract: 0 = clean, any non-zero = failure — a gate failure (report on stderr)
 * and an IO failure exit non-zero, undistinguished. `CheckFailed` is caught inside the
 * handler (not at the bin's run boundary) so the contract survives folding into the shared
 * `pipeline-cli` bin, which provides only `NodeServices.layer`.
 */
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "../../find-root-dir.ts";
import {onCheckFailed} from "../../gate-fail.ts";
import {checkChangeDetect} from "./gate.ts";

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
	Flag.withDescription("the repo root to read ci.yml under (default: walk up for one)"),
);

const resolveRoot = (root: Option.Option<string>): string =>
	Option.getOrElse(root, () => defaultRoot());

const check = Command.make(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root: rootOpt}) {
		yield* checkChangeDetect(resolveRoot(rootOpt)).pipe(
			Effect.catchTag("CheckFailed", onCheckFailed),
		);
	}),
).pipe(
	Command.withDescription(
		"Fail the build if ci.yml's changes-job dorny/paths-filter step isn't in API-free git-mode (token: '')",
	),
);

export const changeDetectGuardCommand = Command.make("change-detect-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed gate: ci.yml's change-detection step stays API-free git-mode (no flaky GitHub-API read, #3245)",
	),
);
