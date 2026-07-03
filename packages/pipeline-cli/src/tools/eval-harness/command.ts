/**
 * The `eval-harness` tool — `pipeline-cli eval-harness check <manifest>`.
 *
 * The graded-corpus apparatus for adjudicating a stochastic model swap per stage (epic
 * #1842). This first slice ships the FORMAT + its decode/encode core (issue #1848); it
 * does NOT populate real entries, run any stage, or compute any metric — those are later
 * children. The one live surface is a validator over the on-disk format:
 *
 *   pipeline-cli eval-harness check <manifest>   # decode a corpus manifest; exit non-zero on a bad one
 *
 * Thin IO shell over the pure `decodeManifest` core (the `token-spend` / `readme-guard`
 * idiom): read the file, decode, report. An unreadable path and a malformed/mismatched
 * manifest both exit non-zero — this is a named, explicit validation target, so a bad
 * input is an error, not a silent pass.
 */
import {readFileSync} from "node:fs";
import {Console, Data, Effect, Result} from "effect";
import {Argument, Command} from "effect/unstable/cli";
import {decodeManifest} from "./corpus.ts";

const GATE_FAIL_EXIT_CODE = 1;

// A named manifest path that could not be read — a hard error (exit 1), not a skip.
class ManifestUnreadable extends Data.TaggedError("ManifestUnreadable")<{
	readonly path: string;
}> {}

const manifestArg = Argument.string("manifest").pipe(
	Argument.withDescription("path to a corpus manifest JSON file to validate against the schema"),
);

const check = Command.make(
	"check",
	{manifest: manifestArg},
	Effect.fn(function* ({manifest}) {
		const run = Effect.gen(function* () {
			const text = yield* Effect.try({
				try: () => readFileSync(manifest, "utf8"),
				catch: () => new ManifestUnreadable({path: manifest}),
			});
			const result = decodeManifest(text);
			if (Result.isFailure(result)) {
				yield* Console.error(
					`eval-harness: ${manifest} is not a valid corpus manifest (${result.failure.reason}): ${result.failure.message}`,
				);
				return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
			}
			yield* Console.log(`eval-harness: ${manifest} is a valid corpus manifest.`);
		});
		yield* run.pipe(
			Effect.catchTag("ManifestUnreadable", (e) =>
				Effect.gen(function* () {
					yield* Console.error(`eval-harness: cannot read manifest ${e.path}`);
					return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
				}),
			),
		);
	}),
).pipe(
	Command.withDescription(
		"Validate a corpus manifest file against the schema (exit non-zero on a bad one)",
	),
);

export const evalHarnessCommand = Command.make("eval-harness").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Graded per-stage corpus: the labeled ground-truth format for model-tiering evaluation (#1848)",
	),
);
