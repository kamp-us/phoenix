/**
 * The `decisions-index` tool — `pipeline-cli decisions-index <compact|validate|generate|check>`.
 *
 * The author + CI surface, moved into the pipeline-cli registry (epic #994, Phase 2
 * / #997):
 *   pipeline-cli decisions-index compact           # emit the compact ambient ADR map to stdout (ADR 0126 / #1728)
 *   pipeline-cli decisions-index next              # emit the next free ADR number (deterministic allocator — #2064)
 *   pipeline-cli decisions-index validate          # PR gate: exit non-zero on a duplicate / mismatched id
 *   pipeline-cli decisions-index generate           # (legacy) rewrite a .decisions/index.md file locally
 *   pipeline-cli decisions-index check             # (legacy) exit non-zero on a stale committed index
 *   pipeline-cli decisions-index <mode> --dir <d>  # point at a specific .decisions dir
 *
 * `compact` is the ambient-discovery surface (ADR 0126): there is no committed
 * `.decisions/index.md` anymore — discovery goes ambient via a SessionStart hook
 * (#1728) that injects this one-line-per-ADR map, with `ls .decisions/` + frontmatter
 * as the fallback. It derives purely from ADR frontmatter, so it never drifts.
 * `next` is the deterministic ADR-number allocator (#2064): it prints `max(id) + 1`
 * zero-padded, so an author runs `pipeline-cli decisions next` instead of eyeballing
 * `.decisions/` (which goes stale between a local checkout and origin/main, or races
 * two simultaneous authors onto the same guess). Paired with `validate` — the allocator
 * kills the stale-guess case, `validate` backs the rare simultaneous case — the two are
 * collision-proof without a date-slug rename (supersedes #2058).
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
import {Effect, FileSystem, Option, Path} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import type {CheckFailed} from "./gate.ts";
import {checkIndex, compactIndex, generateIndex, nextIndex, validateAdrs} from "./gate.ts";

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
 *
 * The marker probes go through the `FileSystem`/`Path` seam (over the bin's
 * `NodeServices.layer`), so this resolver is testable off real disk
 * (.patterns/effect-platform-access.md). Mirrors the pure upward walk (dirname to the
 * fixpoint), but `fs.exists` yields an Effect so the walk lives here; a probe fault
 * falls through as false, matching the former `existsSync`.
 */
const defaultDecisionsDir = Effect.fn(function* (from: string = process.cwd()) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const start = path.resolve(from);
	let dir = start;
	for (;;) {
		for (const marker of ROOT_MARKERS) {
			if (yield* fs.exists(path.join(dir, marker)).pipe(Effect.orElseSucceed(() => false)))
				return path.join(dir, DECISIONS_DIR);
		}
		const parent = path.dirname(dir);
		if (parent === dir) return path.join(start, DECISIONS_DIR);
		dir = parent;
	}
});

// Optional, not defaulted: an absent --dir resolves to the repo-root `.decisions`
// (see `defaultDecisionsDir`); a passed --dir is honored verbatim, relative to cwd.
const dirFlag = Flag.string("dir").pipe(
	Flag.optional,
	Flag.withDescription(
		"the .decisions directory to read ADR files from (default: the repo-root .decisions)",
	),
);

const resolveDir = (
	dir: Option.Option<string>,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
	Option.match(dir, {onNone: () => defaultDecisionsDir(), onSome: Effect.succeed});

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
		const dir = yield* resolveDir(dirOpt);
		yield* compactIndex(dir).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription(
		"Emit the compact ambient ADR map (one line per ADR: id · title · status) to stdout (ADR 0126)",
	),
);

const next = Command.make(
	"next",
	{dir: dirFlag},
	Effect.fn(function* ({dir: dirOpt}) {
		const dir = yield* resolveDir(dirOpt);
		yield* nextIndex(dir).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription(
		"Emit the next free ADR number (max id + 1, zero-padded) — the deterministic allocator authors run before /adr (#2064)",
	),
);

const generate = Command.make(
	"generate",
	{dir: dirFlag},
	Effect.fn(function* ({dir: dirOpt}) {
		const dir = yield* resolveDir(dirOpt);
		yield* generateIndex(dir).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(Command.withDescription("Regenerate .decisions/index.md from the ADR files"));

const validate = Command.make(
	"validate",
	{dir: dirFlag},
	Effect.fn(function* ({dir: dirOpt}) {
		const dir = yield* resolveDir(dirOpt);
		yield* validateAdrs(dir).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
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
		const dir = yield* resolveDir(dirOpt);
		yield* checkIndex(dir).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription("Verify the committed index.md is fresh and has no duplicate ADR id"),
);

export const decisionsIndexCommand = Command.make("decisions-index").pipe(
	Command.withSubcommands([compact, next, validate, generate, check]),
	Command.withDescription(
		"Ambient ADR discovery: emit the compact map, allocate the next ADR number, + validate ADR files (ADR 0126 / #2064)",
	),
);
