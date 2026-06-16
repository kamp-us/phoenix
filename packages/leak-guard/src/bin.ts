/**
 * `leak-guard scan` CLI — the CI-callable surface for issue #173.
 *
 * `node src/bin.ts scan <file>...` reads each file, runs the pure `findLeaks`
 * core, and reports `<file>: <matched> — <reason>` lines. A missing/unreadable
 * file is skipped, never a crash. `findLeaks` already scopes to doc surfaces, so
 * CI may hand it every changed file — only doc-surface leaks are flagged.
 *
 * Exit-code contract: 2 on a confirmed leak, 0 when clean, and any OTHER
 * non-zero means the scan could not complete (e.g. node module-load failure
 * before any Effect runs). The pre-commit hook fail-opens on can't-run (warn +
 * allow); CI fail-closes (any non-zero fails the gate). See issue #332.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/epic-ledger`):
 * `effect/unstable/cli` for the variadic file argument, the Node platform over
 * `NodeServices.layer`, run via `NodeRuntime.runMain` (a failed effect → a
 * non-zero process exit).
 */
import {readFileSync} from "node:fs";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
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

const scan = Command.make(
	"scan",
	{files: fileArg},
	Effect.fn(function* ({files}) {
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
			"Use a repo-relative path (apps/web/..., .claude/skills/...). If this is a documented pattern, not a real path, add the surface to DOC_SELF_EXEMPT in packages/leak-guard/src/leak-guard.ts.",
		);
		// A failed effect → NodeRuntime exits non-zero. The report is already on stderr.
		return yield* Effect.fail(new LeakFound({count: flagged.length}));
	}),
).pipe(Command.withDescription("Scan files for user-local paths leaking into shared doc surfaces"));

const guard = Command.make("leak-guard").pipe(
	Command.withSubcommands([scan]),
	Command.withDescription("Block user-local paths from entering shared-artifact doc surfaces"),
);

guard.pipe(
	Command.run({version: "0.0.0"}),
	// LeakFound is the expected CI-fail signal, its report already on stderr — turn
	// it into a bare non-zero exit so NodeRuntime doesn't also dump a stack trace,
	// while genuine crashes still get the default error report.
	Effect.catchTag("LeakFound", () => Effect.sync(() => process.exit(LEAK_EXIT_CODE))),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
