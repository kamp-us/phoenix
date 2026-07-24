/**
 * The `leak-guard` tool — `pipeline-cli leak-guard scan <file>...`.
 *
 * The CI-callable scan for issue #173, moved into the pipeline-cli registry (epic
 * #994, Phase 2 / #999):
 *
 *   pipeline-cli leak-guard scan <file>...        # report user-local path leaks in doc files; exit 2 on a leak
 *   pipeline-cli leak-guard scan-comment          # scan a PR/issue comment body (stdin) before posting; exit 2 on a leak
 *
 * Reads each file, runs the pure `findLeaks` core, and reports
 * `<file>: <matched> — <reason>` lines on stderr. A missing/unreadable file is
 * skipped, never a crash. `findLeaks` already scopes to doc surfaces, so CI may
 * hand it every changed file — only doc-surface leaks are flagged.
 *
 * Exit-code contract (preserved from the former package's `bin.run.ts`): 2 on a
 * confirmed leak, 0 when clean, and any OTHER non-zero means the scan could not
 * complete. The pre-commit hook fail-opens on can't-run (warn + allow); CI
 * fail-closes (any non-zero fails the gate). See issue #332.
 *
 * The former package mapped `LeakFound` → exit 2 at its own run boundary; here
 * the catch lives inside the `scan` handler so the contract survives folding into
 * the shared `pipeline-cli` bin, which provides only `NodeServices.layer` and no
 * per-tool catch. The package's #777 stale-tree shim (`bin.ts` / `preflight.ts`)
 * is dropped: the `pipeline-cli` bin imports `@effect/platform-node` statically,
 * so by the time this command runs the runtime dep is always resolved.
 */
import {existsSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Console, Effect, Option} from "effect";
import * as Schema from "effect/Schema";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "../../find-root-dir.ts";
import {type CheckFailed, CREW_DIR, sweepCrew} from "./crew-gate.ts";
import {PrComments, PrCommentsLive, type UpstreamUnavailableError} from "./github.ts";
import {findCommentLeaks, findLeaks, type Leak} from "./leak-guard.ts";
import {scanPrComments} from "./scan-pr.ts";

// 2 = a confirmed leak; any OTHER non-zero from this process means the scan
// could not complete, which the pre-commit hook treats as warn-and-allow while
// CI treats as failure (issue #332).
const LEAK_EXIT_CODE = 2;

// 3 = the scan could not VERIFY — GitHub was transiently unavailable past the retry budget
// (`scan-pr` only). Distinct from a leak (2) and a clean pass (0): it is one of the "any OTHER
// non-zero = could not complete" codes, so the ship-it Step 3.7 gate still BLOCKS (fail-safe) —
// a leak gate must never pass what it could not read — but legibly, never as an opaque stack
// trace posing as a finding (issue #3710).
const UPSTREAM_UNAVAILABLE_EXIT_CODE = 3;

interface FileLeaks {
	readonly file: string;
	readonly leaks: ReadonlyArray<Leak>;
}

// Carries a non-zero process exit (the report is already on stderr).
class LeakFound extends Schema.TaggedErrorClass<LeakFound>()("LeakFound", {
	count: Schema.Number,
}) {}

/** Read a file as UTF-8, or `null` when it is missing/unreadable (skip, never crash). */
const readFileOrSkip = (file: string): Effect.Effect<string | null> =>
	Effect.try({
		try: () => readFileSync(file, "utf8"),
		catch: () => null,
	}).pipe(Effect.orElseSucceed(() => null));

const scanFile = (file: string): Effect.Effect<FileLeaks> =>
	readFileOrSkip(file).pipe(
		Effect.map((content) => ({
			file,
			leaks: content === null ? [] : findLeaks(file, content),
		})),
	);

const fileArg = Argument.string("file").pipe(
	Argument.atLeast(1),
	Argument.withDescription("one or more file paths to scan for user-local path leaks"),
);

// LeakFound is the expected CI-fail signal, its report already on stderr — turn it
// into a bare non-zero exit so NodeRuntime doesn't also dump a stack trace. Caught
// per-handler (not at the bin's run boundary) so the contract survives the fold
// into the shared `pipeline-cli` bin, which provides no per-tool catch.
const onLeakFound = () => Effect.sync(() => process.exit(LEAK_EXIT_CODE));

const scan = Command.make(
	"scan",
	{files: fileArg},
	Effect.fn(function* ({files}) {
		const run = Effect.gen(function* () {
			const results = yield* Effect.forEach(files, scanFile, {concurrency: 1});
			const flagged = results.filter((r) => r.leaks.length > 0);

			if (flagged.length === 0) {
				yield* Console.log("leak-guard: clean — no user-local paths in any scanned doc surface");
				return;
			}

			yield* Console.error(
				"leak-guard: blocked — user-local path(s) in shared doc surface(s) (issue #173):",
			);
			for (const {file, leaks} of flagged) {
				for (const leak of leaks) {
					yield* Console.error(`  ${file}: ${leak.matched} — ${leak.reason}`);
				}
			}
			yield* Console.error(
				"Use a repo-relative path (apps/web/..., .claude/skills/...). If this is a documented pattern, not a real path, add the surface to DOC_SELF_EXEMPT in packages/pipeline-cli/src/tools/leak-guard/leak-guard.ts.",
			);
			// A failed effect → a non-zero exit. The report is already on stderr.
			return yield* Effect.fail(new LeakFound({count: flagged.length}));
		});
		yield* run.pipe(Effect.catchTag("LeakFound", onLeakFound));
	}),
).pipe(Command.withDescription("Scan files for user-local paths leaking into shared doc surfaces"));

// The repeatable pipeline-crew sanitization sweep (#2357). Where `scan` takes explicit
// changed files and checks only the no-local-paths rule on doc surfaces, `sweep` walks
// a whole directory and checks EVERY personal-data class the crew's "zero real operator
// data" contract bans — fail-closed on any hit and on a zero-file scope (ADR 0092),
// mirroring the readme-guard/fanout-guard directory-check idiom.
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
	Flag.withDescription("the repo root to resolve the crew dir under (default: walk up for one)"),
);
const dirFlag = Flag.string("dir").pipe(
	Flag.optional,
	Flag.withDescription(`the crew directory to sweep, root-relative (default: ${CREW_DIR})`),
);

// CheckFailed carries the expected gate-fail signal — its report is already built; print
// it on stderr and exit non-zero without a stack trace. Caught inside the handler (not at
// the bin's run boundary) so the contract survives the fold into the shared pipeline-cli bin.
const onCheckFailed = (e: CheckFailed) =>
	Effect.sync(() => {
		process.stderr.write(`${e.reason}\n`);
		process.exit(GATE_FAIL_EXIT_CODE);
	});

const sweep = Command.make(
	"sweep",
	{root: rootFlag, dir: dirFlag},
	Effect.fn(function* ({root, dir}) {
		const base = Option.getOrElse(root, () => defaultRoot());
		yield* sweepCrew(
			base,
			Option.getOrElse(dir, () => CREW_DIR),
		).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription(
		"Sweep the pipeline-crew dir for personal-data leaks; fail-closed on any hit or zero scope",
	),
);

// The pre-post net for a PR/issue COMMENT body (#2796). Where `scan` takes doc FILES and
// `findLeaks` scopes to doc surfaces, this takes a single comment body on stdin/`--body-file`
// and runs `findCommentLeaks` — which has no doc-surface gate (a comment is unconditionally a
// public artifact) and the stricter temp-root patterns (`/var/folders`, `/private/tmp`, `/tmp`).
// A `review-*` verdict-posting step runs it before `gh api …/comments` so a bypass of the
// verdict-lib `post` seam can't silently land a scratchpad/@-filepath body on a public PR.
const commentBodyFlag = Flag.string("body-file").pipe(
	Flag.optional,
	Flag.withDescription("path to the comment body to scan (default: read the body from stdin)"),
);

const readCommentBody = (bodyFile: Option.Option<string>): Effect.Effect<string> =>
	Effect.sync(() =>
		Option.match(bodyFile, {
			onNone: () => readFileSync(0, "utf8"),
			onSome: (path) => readFileSync(path, "utf8"),
		}),
	);

const scanComment = Command.make(
	"scan-comment",
	{bodyFile: commentBodyFlag},
	Effect.fn(function* ({bodyFile}) {
		const run = Effect.gen(function* () {
			const body = yield* readCommentBody(bodyFile);
			const leaks = findCommentLeaks(body);
			if (leaks.length === 0) {
				yield* Console.log("leak-guard: clean — no machine-local paths in the comment body");
				return;
			}
			yield* Console.error(
				"leak-guard: blocked — machine-local path(s) in a PR/issue comment body (issue #2796):",
			);
			for (const leak of leaks) {
				yield* Console.error(`  ${leak.matched} — ${leak.reason}`);
			}
			yield* Console.error(
				"A verdict/PR comment must inline its TEXT with repo-relative paths only — never a scratchpad/@-filepath ref or a temp path. Post the verdict CONTENT, not a local path.",
			);
			return yield* Effect.fail(new LeakFound({count: leaks.length}));
		});
		yield* run.pipe(Effect.catchTag("LeakFound", onLeakFound));
	}),
).pipe(
	Command.withDescription(
		"Scan a PR/issue comment body for machine-local path leaks before posting (exit 2 on a leak)",
	),
);

// The LANDED-comment scan (#3019). Where `scan-comment` nets a body BEFORE it is posted (an
// emit-side step a bypass skips), `scan-pr` re-checks the comments that ALREADY landed on a PR —
// the issue conversation + the inline review comments, straight off the REST boundary — so a leak
// posted via a raw `gh api …/comments` that never touched the verdict tool is still caught. ship-it
// runs this as a preflight before enqueue and refuses to merge on a live leak (route to redact-leaks
// + repair). Exit 2 = a live leak (same LEAK_EXIT_CODE contract as `scan`), 0 = clean.
const prArg = Argument.integer("pr").pipe(
	Argument.withDescription("the pull request number whose landed comments to scan for leaks"),
);

// The unknown outcome (#3710): GitHub stayed 5xx/unreachable past the retry budget, so the scan
// could not READ the comments — NOT a leak finding. Print the fail-safe block reason legibly and
// exit 3, distinct from a leak (2). Caught in-handler like LeakFound so no stack trace escapes.
const onUpstreamUnavailable = (e: UpstreamUnavailableError) =>
	Effect.sync(() => {
		process.stderr.write(
			`leak-guard: could not verify — GitHub upstream unavailable on PR #${e.pr} after ${e.attempts} attempts (${e.detail || `exit ${e.lastExitCode}`}).\n` +
				"This is NOT a leak finding: the scan could not read the PR's comments. The merge is BLOCKED (fail-safe) until leaks can be verified — retry shortly.\n",
		);
		process.exit(UPSTREAM_UNAVAILABLE_EXIT_CODE);
	});

const scanPr = Command.make(
	"scan-pr",
	{pr: prArg},
	Effect.fn(function* ({pr}) {
		const run = Effect.gen(function* () {
			const comments = yield* (yield* PrComments).fetch(pr);
			const leaks = scanPrComments(comments);
			if (leaks.length === 0) {
				yield* Console.log(
					`leak-guard: clean — no machine-local paths in any landed comment on PR #${pr} (${comments.length} scanned)`,
				);
				return;
			}
			yield* Console.error(
				`leak-guard: blocked — machine-local path(s) in landed comment(s) on PR #${pr} (issue #3019):`,
			);
			for (const {id, kind, leak} of leaks) {
				yield* Console.error(`  ${kind} comment ${id}: ${leak.matched} — ${leak.reason}`);
			}
			yield* Console.error(
				"Redact each flagged comment (pipeline-cli redact-leaks) and re-post it, then re-run — a merge must not carry a machine-local path in any comment.",
			);
			return yield* Effect.fail(new LeakFound({count: leaks.length}));
		});
		yield* run.pipe(
			Effect.catchTag("LeakFound", onLeakFound),
			Effect.catchTag("@kampus/leak-guard/UpstreamUnavailableError", onUpstreamUnavailable),
		);
	}),
).pipe(
	Command.withDescription(
		"Scan a PR's landed comments (issue + review) for machine-local path leaks (exit 2 on a leak)",
	),
	Command.provide(PrCommentsLive),
);

export const leakGuardCommand = Command.make("leak-guard").pipe(
	Command.withSubcommands([scan, sweep, scanComment, scanPr]),
	Command.withDescription("Block user-local paths from entering shared-artifact doc surfaces"),
);
