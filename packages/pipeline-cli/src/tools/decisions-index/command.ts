/**
 * The `decisions-index` tool — `pipeline-cli decisions-index <compact|validate|generate|check>`.
 *
 * The author + CI surface, moved into the pipeline-cli registry (epic #994, Phase 2
 * / #997):
 *   pipeline-cli decisions-index compact           # emit the compact ambient ADR map to stdout (ADR 0126 / #1728)
 *   pipeline-cli decisions-index validate          # PR gate: exit non-zero on a duplicate / mismatched id
 *   pipeline-cli decisions-index generate           # (legacy) rewrite a .decisions/index.md file locally
 *   pipeline-cli decisions-index check             # (legacy) exit non-zero on a stale committed index
 *   pipeline-cli decisions-index <mode> --dir <d>  # point at a specific .decisions dir
 *
 * `compact` is the ambient-discovery surface (ADR 0126): there is no committed
 * `.decisions/index.md` anymore — discovery goes ambient via a SessionStart hook
 * (#1728) that injects this one-line-per-ADR map, with `ls .decisions/` + frontmatter
 * as the fallback. It derives purely from ADR frontmatter, so it never drifts.
 * `validate` is the PR-side number-lock backstop (duplicate / mismatched id — #1471).
 * `generate`/`check` are legacy committed-index surfaces retained for local use only;
 * they are no longer wired into any workflow (the index is not committed — ADR 0126).
 *
 * Exit-code contract (preserved from the package's former `bin.ts`): 0 = clean,
 * any non-zero = failure. `CheckFailed` is the expected gate-fail — its reason
 * prints on stderr and the process exits non-zero *without* a stack trace; a
 * genuine IO crash still gets the default error report (also non-zero). The
 * former bin mapped `CheckFailed` at the run boundary; here it is caught inside
 * each subcommand's handler so the contract survives folding into the shared
 * `pipeline-cli` bin (which provides only `NodeServices.layer`, no per-tool catch).
 */
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "./decisions-index.ts";
import type {CheckFailed} from "./gate.ts";
import {checkIndex, compactIndex, generateIndex, validateAdrs} from "./gate.ts";

const GATE_FAIL_EXIT_CODE = 1;
const DECISIONS_DIR = ".decisions";
// Repo-root markers, in priority order. `.decisions` itself is the strongest
// signal (the dir we'll read); a workspace/VCS marker is the fallback.
const ROOT_MARKERS = [DECISIONS_DIR, "pnpm-workspace.yaml", ".git"] as const;

/**
 * Resolve the default `.decisions` directory against the REPO ROOT, not the cwd.
 *
 * `pnpm --filter <pkg> <script>` runs with cwd = the package dir, so a bare
 * `.decisions` default resolves to `packages/<pkg>/.decisions` and ENOENTs (#447).
 * Walk up from cwd for the first ancestor carrying a repo-root marker and read
 * `.decisions` there; this is foreign-repo-safe (no phoenix path hardcoded) and
 * keeps CI working (it runs from the root, where cwd === root). If no marker is
 * found we fall back to cwd's `.decisions` — the pre-fix behavior.
 */
const defaultDecisionsDir = (from: string = process.cwd()): string => {
	const start = resolve(from);
	const root = findRootDir(
		start,
		(dir) => ROOT_MARKERS.some((marker) => existsSync(join(dir, marker))),
		dirname,
	);
	return join(root ?? start, DECISIONS_DIR);
};

// Optional, not defaulted: an absent --dir resolves to the repo-root `.decisions`
// (see `defaultDecisionsDir`); a passed --dir is honored verbatim, relative to cwd.
const dirFlag = Flag.string("dir").pipe(
	Flag.optional,
	Flag.withDescription(
		"the .decisions directory to read ADR files from (default: the repo-root .decisions)",
	),
);

const resolveDir = (dir: Option.Option<string>): string =>
	Option.getOrElse(dir, () => defaultDecisionsDir());

// CheckFailed is the expected gate-fail signal — print its reason on stderr and exit
// non-zero WITHOUT a stack trace; genuine crashes (IoError, etc.) still get the
// default error report (also a non-zero exit — both are failures, undistinguished).
// Caught per-handler (not at the bin's run boundary) so the contract survives the
// fold into the shared `pipeline-cli` bin, which provides no per-tool catch.
const onCheckFailed = (e: CheckFailed) =>
	Effect.sync(() => {
		process.stderr.write(`decisions-index: ${e.reason}\n`);
		process.exit(GATE_FAIL_EXIT_CODE);
	});

const compact = Command.make(
	"compact",
	{dir: dirFlag},
	Effect.fn(function* ({dir: dirOpt}) {
		yield* compactIndex(resolveDir(dirOpt)).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription(
		"Emit the compact ambient ADR map (one line per ADR: id · title · status) to stdout (ADR 0126)",
	),
);

const generate = Command.make(
	"generate",
	{dir: dirFlag},
	Effect.fn(function* ({dir: dirOpt}) {
		yield* generateIndex(resolveDir(dirOpt)).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(Command.withDescription("Regenerate .decisions/index.md from the ADR files"));

const validate = Command.make(
	"validate",
	{dir: dirFlag},
	Effect.fn(function* ({dir: dirOpt}) {
		yield* validateAdrs(resolveDir(dirOpt)).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription(
		"PR gate: verify the ADR files have no duplicate or mismatched id (no index-freshness check)",
	),
);

const check = Command.make(
	"check",
	{dir: dirFlag},
	Effect.fn(function* ({dir: dirOpt}) {
		yield* checkIndex(resolveDir(dirOpt)).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription("Verify the committed index.md is fresh and has no duplicate ADR id"),
);

export const decisionsIndexCommand = Command.make("decisions-index").pipe(
	Command.withSubcommands([compact, validate, generate, check]),
	Command.withDescription(
		"Ambient ADR discovery: emit the compact map + validate ADR files (ADR 0126)",
	),
);
