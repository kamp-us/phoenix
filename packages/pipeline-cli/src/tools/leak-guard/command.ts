/**
 * The `leak-guard` tool — `pipeline-cli leak-guard scan <file>...`.
 *
 * The CI-callable scan for issue #173, moved into the pipeline-cli registry (epic
 * #994, Phase 2 / #999):
 *
 *   pipeline-cli leak-guard scan <file>...   # report user-local path leaks; exit 2 on a leak
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
import {readFileSync} from "node:fs";
import {Console, Data, Effect} from "effect";
import {Argument, Command} from "effect/unstable/cli";
import {findLeaks, type Leak} from "./leak-guard.ts";

// 2 = a confirmed leak; any OTHER non-zero from this process means the scan
// could not complete, which the pre-commit hook treats as warn-and-allow while
// CI treats as failure (issue #332).
const LEAK_EXIT_CODE = 2;

interface FileLeaks {
	readonly file: string;
	readonly leaks: ReadonlyArray<Leak>;
}

// Carries a non-zero process exit (the report is already on stderr).
class LeakFound extends Data.TaggedError("LeakFound")<{readonly count: number}> {}

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
			const results = yield* Effect.forEach(files, scanFile);
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

export const leakGuardCommand = Command.make("leak-guard").pipe(
	Command.withSubcommands([scan]),
	Command.withDescription("Block user-local paths from entering shared-artifact doc surfaces"),
);
