/**
 * `ci changelog` — derive one Keep-a-Changelog release section from a gathered entries JSON.
 *
 * The operable surface of ADR 0069: `CHANGELOG.md` is a projection of the pipeline's closed-issue
 * and merged-PR metadata, not a hand-edited doc. `changelog.yml` gathers the range's entries with
 * `git log` + `gh` and hands them here on release.
 *
 * Schema sits at the trust boundary (`.patterns/effect-schema-validation.md`): the untrusted
 * entries JSON is decoded once, and every step downstream of it is total.
 */

import {Effect, type FileSystem, type Path, Schema} from "effect";
import {readFile, writeFile} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {type ChangelogEntry, deriveChangelog, type ReleaseMeta} from "./changelog.ts";
import {MALFORMED_DOCUMENT, PRECONDITION_UNKNOWN, WRITE_UNKNOWN} from "./codes.ts";

const VERB = "ci changelog";

/** One entry as the gathered JSON carries it; decoded at this boundary. */
const EntrySchema = Schema.Struct({
	issue: Schema.Number,
	pr: Schema.optional(Schema.Number),
	title: Schema.String,
	type: Schema.optional(Schema.String),
});

const decodeEntries = Schema.decodeUnknownEffect(Schema.Array(EntrySchema));

export interface ChangelogOptions {
	/** Path to the gathered entries JSON. */
	readonly entries: string;
	/** The release version for the `## [version]` heading. */
	readonly version: string;
	/** Release date as `YYYY-MM-DD`, or `null` for today (UTC). */
	readonly date: string | null;
	/** Write the changelog here instead of returning it on stdout. */
	readonly out: string | null;
}

const today = (): string => new Date().toISOString().slice(0, 10);

const loadEntries = (
	file: string,
): Effect.Effect<ReadonlyArray<ChangelogEntry>, VerbOutcome, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const text = yield* readFile(file).pipe(
			Effect.mapError((failure) =>
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read ${file}: ${failure.reason} — the entries the section is derived from are unreadable, so the verdict is UNKNOWN.`,
				),
			),
		);
		const parsed = yield* Effect.try({
			try: () => JSON.parse(text) as unknown,
			catch: (cause) =>
				refuse(MALFORMED_DOCUMENT, `${VERB}: ${file} is not valid JSON: ${String(cause)}.`),
		});
		return yield* decodeEntries(parsed).pipe(
			Effect.mapError((cause) =>
				refuse(
					MALFORMED_DOCUMENT,
					`${VERB}: ${file} is not a ChangelogEntry[] — every entry needs a numeric \`issue\` and a string \`title\` (${String(cause)}).`,
				),
			),
		);
	});

export const runChangelog = (
	options: ChangelogOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const entries = yield* loadEntries(options.entries);
		const meta: ReleaseMeta = {version: options.version, date: options.date ?? today()};
		const markdown = deriveChangelog([{meta, entries}]);
		if (options.out === null) return answer(markdown);
		const out = options.out;
		yield* writeFile(out, markdown).pipe(
			Effect.mapError((failure) =>
				refuse(
					WRITE_UNKNOWN,
					`${VERB}: cannot write ${out}: ${failure.reason} — whether the section landed is UNKNOWN.`,
				),
			),
		);
		return answer("", [
			`${VERB}: wrote ${entries.length} entr${entries.length === 1 ? "y" : "ies"} to ${out}`,
		]);
	}).pipe(Effect.catch(Effect.succeed));
