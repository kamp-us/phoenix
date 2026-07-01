/**
 * The `ship-digest` tool — `pipeline-cli ship-digest derive` (issue #1595).
 *
 *   pipeline-cli ship-digest derive --entries <file> --since <YYYY-MM-DD> [--until <YYYY-MM-DD>] [--out <file>]
 *
 * Reads a pre-gathered merged-work entries JSON (product/infra `area`, milestone, `type:*`,
 * PR + optional issue), runs the pure `deriveShipDigest` core, and writes the founder-facing
 * grouped digest to `--out` (default: stdout). With `--out`, stdout stays empty and a
 * progress line goes to stderr.
 *
 * Per `.patterns/effect-schema-validation.md`, Schema lives at this trust boundary: the
 * untrusted entries JSON is decoded into `ShipEntry[]` here, and everything downstream is
 * total. A malformed/unreadable entries file is a typed `EntriesReadError` (a non-zero exit),
 * not a throw. Mirrors `changelog-derive`'s flag/stdout/stderr/exit contract; the shared
 * `pipeline-cli` bin owns the run boundary. The git-log/`gh` gather that builds the entries
 * JSON is the `/what-shipped` skill's job, not this tool.
 */
import {readFileSync, writeFileSync} from "node:fs";
import {Console, Data, Effect} from "effect";
import * as Schema from "effect/Schema";
import {Command, Flag} from "effect/unstable/cli";
import {type DigestWindow, deriveShipDigest, type ShipEntry} from "./digest.ts";

class EntriesReadError extends Data.TaggedError("EntriesReadError")<{
	readonly file: string;
	readonly cause: unknown;
}> {}

/** One entry as the gathered JSON carries it; decoded at this boundary. */
const EntrySchema = Schema.Struct({
	issue: Schema.optional(Schema.Number),
	pr: Schema.Number,
	title: Schema.String,
	type: Schema.optional(Schema.String),
	milestone: Schema.optional(Schema.String),
	area: Schema.optional(Schema.String),
});

const EntriesSchema = Schema.Array(EntrySchema);

const decodeEntries = Schema.decodeUnknownEffect(EntriesSchema);

/** Read + JSON-parse + decode the entries file, all failures typed. */
const loadEntries = (file: string): Effect.Effect<ReadonlyArray<ShipEntry>, EntriesReadError> =>
	Effect.try({
		try: () => JSON.parse(readFileSync(file, "utf8")) as unknown,
		catch: (cause) => new EntriesReadError({file, cause}),
	}).pipe(
		Effect.flatMap((raw) =>
			decodeEntries(raw).pipe(Effect.mapError((cause) => new EntriesReadError({file, cause}))),
		),
	);

const today = (): string => new Date().toISOString().slice(0, 10);

const entriesFlag = Flag.file("entries").pipe(
	Flag.withDescription("path to the gathered merged-work entries JSON (product/infra facts)"),
);

const sinceFlag = Flag.string("since").pipe(
	Flag.withDescription("window lower bound (YYYY-MM-DD) — the merged-since date"),
);

const untilFlag = Flag.string("until").pipe(
	Flag.optional,
	Flag.withDescription("window upper bound (YYYY-MM-DD); defaults to today (UTC)"),
);

const outFlag = Flag.string("out").pipe(
	Flag.optional,
	Flag.withDescription("write the digest to this file; defaults to stdout"),
);

const derive = Command.make(
	"derive",
	{entries: entriesFlag, since: sinceFlag, until: untilFlag, out: outFlag},
	Effect.fn(function* ({entries, since, until, out}) {
		const loaded = yield* loadEntries(entries);
		const window: DigestWindow = {since, until: until._tag === "Some" ? until.value : today()};
		const markdown = deriveShipDigest(loaded, window);

		if (out._tag === "Some") {
			const file = out.value;
			yield* Effect.try({
				try: () => writeFileSync(file, markdown),
				catch: (cause) => new EntriesReadError({file, cause}),
			});
			yield* Console.error(`ship-digest: wrote ${loaded.length} entr(y/ies) to ${file}`);
			return;
		}
		yield* Console.log(markdown);
	}),
).pipe(
	Command.withDescription(
		"Derive a founder-facing ship digest (product/infra → milestone → type) from a gathered entries JSON",
	),
);

export const shipDigestCommand = Command.make("ship-digest").pipe(
	Command.withSubcommands([derive]),
	Command.withDescription(
		"Render the merged-since founder ship digest as a projection of gathered pipeline metadata (#1595)",
	),
);
