/**
 * Reading and writing the run directory — the one place the five later verbs touch it.
 *
 * Everything here refuses rather than defaults. A `run.json` that is absent or unparseable is `11`:
 * the run is **UNKNOWN**, never assumed `fresh`. A manifest that will not parse is `11` too, never
 * "this run has no children" — the two take opposite branches and only one of them is a fact.
 *
 * Stdin arrives through the imported three-way read, and its two empty arms never collapse: a
 * non-blocking pipe throws `EAGAIN` before its producer writes, so swallowing that to `""` would make
 * an unread pipe byte-identical to an empty one.
 */

import {Effect, FileSystem, Path} from "effect";
import {renderLeaks, scanBody} from "../report/leaks.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {LEAKED_PATH, PRECONDITION_UNKNOWN} from "./codes.ts";
import type {LedgerMessages} from "./preconditions.ts";
import {
	type ChildRecord,
	manifestPath,
	parseManifest,
	parseRunRecord,
	type RunRecord,
	renderChildRecord,
	renderManifest,
	runJsonPath,
} from "./run.ts";

export type Loaded<A> =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Loaded"; readonly value: A};

const refused = <A>(outcome: VerbOutcome): Loaded<A> => ({_tag: "Refused", outcome});

/** Read a file, or the reason it could not be read — absence and a fault are one answer here. */
const readText = (
	fs: FileSystem.FileSystem,
	path: string,
): Effect.Effect<{text: string} | {reason: string}> =>
	fs.readFileString(path).pipe(
		Effect.map((text) => ({text})),
		Effect.catchTag("PlatformError", (cause) => Effect.succeed({reason: cause.message})),
	);

/** `run.json`, or the `11` refusal. The run is UNKNOWN when it cannot be read or does not parse. */
export const loadRun = (
	messages: LedgerMessages,
	dir: string,
	notes: ReadonlyArray<string>,
): Effect.Effect<Loaded<RunRecord>, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = runJsonPath(dir);
		const read = yield* readText(fs, path);
		if ("reason" in read) {
			return refused<RunRecord>(
				refuse(PRECONDITION_UNKNOWN, messages.unreadable(path, read.reason), notes),
			);
		}
		const record = parseRunRecord(read.text);
		return record === null
			? refused<RunRecord>(
					refuse(PRECONDITION_UNKNOWN, messages.unreadable(path, "it is not a run record"), notes),
				)
			: {_tag: "Loaded", value: record};
	});

/** `children.jsonl`, or the `11` refusal. An absent manifest is unreadable, not empty. */
export const loadManifest = (
	messages: LedgerMessages,
	dir: string,
	notes: ReadonlyArray<string>,
): Effect.Effect<Loaded<ReadonlyArray<ChildRecord>>, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = manifestPath(dir);
		const read = yield* readText(fs, path);
		if ("reason" in read) {
			return refused<ReadonlyArray<ChildRecord>>(
				refuse(PRECONDITION_UNKNOWN, messages.unreadable(path, read.reason), notes),
			);
		}
		const records = parseManifest(read.text);
		return records === null
			? refused<ReadonlyArray<ChildRecord>>(
					refuse(
						PRECONDITION_UNKNOWN,
						messages.unreadable(path, "one of its lines is not a child record"),
						notes,
					),
				)
			: {_tag: "Loaded", value: records};
	});

/** A staged document's bytes, or `null` when this run never staged it. */
export const loadStaged = (
	path: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const read = yield* readText(fs, path);
		return "reason" in read ? null : read.text;
	});

/** Write a document into the run directory; the reason it did not land, or `null`. */
export const stage = (
	path: string,
	text: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const pathService = yield* Path.Path;
		return yield* fs.makeDirectory(pathService.dirname(path), {recursive: true}).pipe(
			Effect.andThen(fs.writeFileString(path, text)),
			Effect.as(null),
			Effect.catchTag("PlatformError", (cause) => Effect.succeed(cause.message)),
		);
	});

/** Append one child record to the manifest; the reason it did not land, or `null`. */
export const appendChild = (
	dir: string,
	record: ChildRecord,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = manifestPath(dir);
		const read = yield* readText(fs, path);
		const current = "reason" in read ? "" : read.text;
		const separator = current === "" || current.endsWith("\n") ? "" : "\n";
		return yield* stage(path, `${current}${separator}${renderChildRecord(record)}\n`);
	});

/** Rewrite one child's manifest line — how a proven link becomes `linked: true`. */
export const rewriteChild = (
	dir: string,
	records: ReadonlyArray<ChildRecord>,
	replacement: ChildRecord,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> =>
	stage(
		manifestPath(dir),
		renderManifest(
			records.map((record) => (record.number === replacement.number ? replacement : record)),
		),
	);

/**
 * The leak refusal over authored text, **masked**.
 *
 * The predicate is the shipped `report/leaks.ts` one, imported; only the wording is this group's — and
 * the one substantive difference from `build/authored.ts`'s sibling is that the path is masked before
 * it is printed. A refusal that quotes the raw path re-leaks it into the run log the refusal was
 * written to keep it out of; masking through the same scanner is what keeps the two consistent.
 */
export const maskedLeakRefusal = (verb: string, what: string, text: string): VerbOutcome | null => {
	const scan = scanBody(text);
	const first = scan.leaks[0];
	if (first === undefined) return null;
	return refuse(
		LEAKED_PATH,
		`${verb}: the ${what} carries a machine-local path (${scanBody(first.text).redacted}).`,
		renderLeaks(scan.leaks),
	);
};
