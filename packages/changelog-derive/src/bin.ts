#!/usr/bin/env node
/**
 * `changelog-derive derive` CLI — the operable surface for ADR 0069 (issue #394).
 *
 * `node src/bin.ts derive --entries <file> --version <v> [--date <YYYY-MM-DD>] [--out <file>]`
 * reads a gathered entries JSON (one release's worth of closed-issue/merged-PR facts),
 * runs the pure `deriveChangelog` core, and writes the Keep a Changelog body to `--out`
 * (default: stdout). The release-time `.github/workflows/` step gathers entries by
 * shelling `gh`/`git` over the range since the previous release tag and feeds this CLI;
 * the `git log` between tags is the *range selector only* — entry text comes from the
 * issue/PR metadata in the JSON (the ADR's source-preference contract).
 *
 * Per `.patterns/effect-schema-validation.md`, Schema lives at this trust boundary: the
 * untrusted entries JSON is decoded into `ChangelogEntry[]` here, and everything
 * downstream is total. A malformed/unreadable entries file is a typed failure, not a
 * throw.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@phoenix/leak-guard` / `@kampus/epic-ledger`):
 * `effect/unstable/cli` for the typed flags, the Node platform over `NodeServices.layer`,
 * run via `NodeRuntime.runMain` (a failed effect → a non-zero process exit).
 */
import {readFileSync, writeFileSync} from "node:fs";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Data, Effect} from "effect";
import * as Schema from "effect/Schema";
import {Command, Flag} from "effect/unstable/cli";
import {type ChangelogEntry, deriveChangelog, type ReleaseMeta} from "./changelog.ts";

class EntriesReadError extends Data.TaggedError("EntriesReadError")<{
	readonly file: string;
	readonly cause: unknown;
}> {}

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

const cli = Command.make("changelog-derive").pipe(
	Command.withSubcommands([derive]),
	Command.withDescription(
		"Derive CHANGELOG.md as a projection of shipped-work pipeline metadata (ADR 0069)",
	),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
