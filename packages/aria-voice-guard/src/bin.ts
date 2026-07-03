/**
 * `aria-voice-guard` scan bin — `aria-voice-guard scan <file>...`.
 *
 * The CI-callable a11y-voice gate for issue #1670. Reads each handed file, runs the
 * pure `findDrift` core (Turkish-locale-correct Title-Case detection), and reports
 * `<file>:<line>: <kind> "<text>" → "<suggestion>"` lines on stderr. A
 * missing/unreadable file is skipped, never a crash — `findDrift` is a pure scan, so
 * CI may hand it every changed file and only real drift is flagged.
 *
 * Exit-code contract (mirrors `leak-guard`, issue #332): 2 on a confirmed drift, 0
 * when clean, and any OTHER non-zero means the scan could not complete. CI
 * fail-closes (any non-zero fails the gate).
 *
 * Wired per effect-smol's CLI guidance (the `@kampus/pipeline-cli` / `leak-guard`
 * idiom): `effect/unstable/cli` for the typed subcommand, the Node platform over
 * `NodeServices.layer`, run via `NodeRuntime.runMain`; invoked with `node src/bin.ts`.
 */
import {readFileSync} from "node:fs";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Data, Effect} from "effect";
import {Argument, Command} from "effect/unstable/cli";
import {type Finding, findDrift} from "./aria-voice-guard.ts";

// 2 = a confirmed drift; any OTHER non-zero from this process means the scan could
// not complete (CI treats it as failure).
const DRIFT_EXIT_CODE = 2;

interface FileDrift {
	readonly file: string;
	readonly findings: ReadonlyArray<Finding>;
}

class DriftFound extends Data.TaggedError("DriftFound")<{readonly count: number}> {}

const readFileOrSkip = (file: string): Effect.Effect<string | null> =>
	Effect.try({
		try: () => readFileSync(file, "utf8"),
		catch: () => null,
	}).pipe(Effect.orElseSucceed(() => null));

const scanFile = (file: string): Effect.Effect<FileDrift> =>
	readFileOrSkip(file).pipe(
		Effect.map((content) => ({
			file,
			findings: content === null ? [] : findDrift(content),
		})),
	);

const fileArg = Argument.string("file").pipe(
	Argument.atLeast(1),
	Argument.withDescription(
		"one or more .tsx file paths to scan for Title-Case aria-labels / menu items",
	),
);

// DriftFound is the expected CI-fail signal, its report already on stderr — turn it
// into a bare non-zero exit so NodeRuntime doesn't also dump a stack trace.
const onDriftFound = () => Effect.sync(() => process.exit(DRIFT_EXIT_CODE));

const scan = Command.make(
	"scan",
	{files: fileArg},
	Effect.fn(function* ({files}) {
		const run = Effect.gen(function* () {
			const results = yield* Effect.forEach(files, scanFile);
			const flagged = results.filter((r) => r.findings.length > 0);

			if (flagged.length === 0) {
				yield* Console.log(
					"aria-voice-guard: clean — no Title-Case aria-label or menu-item string in any scanned file",
				);
				return;
			}

			yield* Console.error(
				"aria-voice-guard: blocked — Title-Case aria-label / menu-item string(s) break the lowercase Turkish voice (issue #1670):",
			);
			for (const {file, findings} of flagged) {
				for (const f of findings) {
					yield* Console.error(`  ${file}:${f.line}: ${f.kind} "${f.text}" → "${f.suggestion}"`);
				}
			}
			yield* Console.error(
				'Lowercase the string to match the visible voice (e.g. "Kapat" → "kapat"). Turkish stays Turkish — this is casing, never translation (CLAUDE.md / .glossary/LANGUAGE.md).',
			);
			return yield* Effect.fail(new DriftFound({count: flagged.length}));
		});
		yield* run.pipe(Effect.catchTag("DriftFound", onDriftFound));
	}),
).pipe(Command.withDescription("Scan .tsx files for Title-Case aria-labels / menu items"));

const cli = Command.make("aria-voice-guard").pipe(
	Command.withSubcommands([scan]),
	Command.withDescription(
		"Guard the lowercase Turkish voice at the aria-label / menu-item seam (issue #1670)",
	),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
