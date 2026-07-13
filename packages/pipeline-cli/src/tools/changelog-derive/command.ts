/**
 * The `changelog-derive` tool — `pipeline-cli changelog-derive derive`.
 *
 * The operable surface for ADR 0069 (issue #394), moved into the pipeline-cli registry
 * (epic #994, Phase 2 / #1002):
 *
 *   pipeline-cli changelog-derive derive --entries <file> --version <v> [--date <YYYY-MM-DD>] [--out <file>]
 *
 * Reads a gathered entries JSON (one release's worth of closed-issue/merged-PR facts),
 * runs the pure `deriveChangelog` core, and writes the Keep a Changelog body to `--out`
 * (default: stdout). With `--out`, stdout stays empty and a progress line goes to stderr.
 *
 * Per `.patterns/effect-schema-validation.md`, Schema lives at this trust boundary: the
 * untrusted entries JSON is decoded into `ChangelogEntry[]` here, and everything
 * downstream is total. A malformed/unreadable entries file is a typed `EntriesReadError`
 * (a non-zero exit), not a throw. The flag surface + stdout/stderr/exit contract is
 * preserved from the former package's `bin.ts`; only the `Command.run`/`Effect.provide`/
 * `runMain` wiring is dropped — the shared `pipeline-cli` bin owns the run boundary.
 */
import {readFileSync, writeFileSync} from "node:fs";
import {Console, Effect} from "effect";
import * as Schema from "effect/Schema";
import {Command, Flag} from "effect/unstable/cli";
import {type ChangelogEntry, deriveChangelog, type ReleaseMeta} from "./changelog.ts";

class EntriesReadError extends Schema.TaggedErrorClass<EntriesReadError>()("EntriesReadError", {
	file: Schema.String,
	cause: Schema.Unknown,
}) {}

/** One entry as the gathered JSON carries it; decoded at this boundary. */
const EntrySchema = Schema.Struct({
	issue: Schema.Number,
	pr: Schema.optional(Schema.Number),
	title: Schema.String,
	type: Schema.optional(Schema.String),
});

const EntriesSchema = Schema.Array(EntrySchema);

const decodeEntries = Schema.decodeUnknownEffect(EntriesSchema);

/** Read + JSON-parse + decode the entries file, all failures typed. */
const loadEntries = (
	file: string,
): Effect.Effect<ReadonlyArray<ChangelogEntry>, EntriesReadError> =>
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
	Flag.withDescription(
		"path to the gathered entries JSON (a release's closed-issue/merged-PR facts)",
	),
);

const versionFlag = Flag.string("version").pipe(
	Flag.withDescription("the release version for the ## [version] heading"),
);

const dateFlag = Flag.string("date").pipe(
	Flag.optional,
	Flag.withDescription("release date (YYYY-MM-DD); defaults to today (UTC)"),
);

const outFlag = Flag.string("out").pipe(
	Flag.optional,
	Flag.withDescription("write the changelog to this file; defaults to stdout"),
);

const derive = Command.make(
	"derive",
	{entries: entriesFlag, version: versionFlag, date: dateFlag, out: outFlag},
	Effect.fn(function* ({entries, version, date, out}) {
		const loaded = yield* loadEntries(entries);
		const meta: ReleaseMeta = {version, date: date._tag === "Some" ? date.value : today()};
		const markdown = deriveChangelog([{meta, entries: loaded}]);

		if (out._tag === "Some") {
			const file = out.value;
			yield* Effect.try({
				try: () => writeFileSync(file, markdown),
				catch: (cause) => new EntriesReadError({file, cause}),
			});
			yield* Console.error(`changelog-derive: wrote ${loaded.length} entr(y/ies) to ${file}`);
			return;
		}
		yield* Console.log(markdown);
	}),
).pipe(
	Command.withDescription(
		"Derive one Keep-a-Changelog release section from a gathered entries JSON",
	),
);

export const changelogDeriveCommand = Command.make("changelog-derive").pipe(
	Command.withSubcommands([derive]),
	Command.withDescription(
		"Derive CHANGELOG.md as a projection of shipped-work pipeline metadata (ADR 0069)",
	),
);
