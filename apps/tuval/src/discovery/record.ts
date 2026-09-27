/**
 * The discovery record: how a second `tuval` process finds the desk already running under this
 * home (#9696, ruling #9668 R6.1, plan grill #9682 R1.2). A desk that serves a page writes one at
 * `<home>/.tuval/desk.json` and removes it as it stops; a desk that crashed leaves it behind, which
 * is why a reader never trusts a record until the desk it names has answered (`./sighting.ts`).
 *
 * The record carries the page's address and nothing secret. A caller asks that page for the
 * transport's launch URL the same way the page itself does, so the per-launch token never reaches
 * the disk (`../page/dev-server.ts`).
 */

import {join} from "node:path";
import {homeTuvalDir} from "@kampus/tuval-sdk/kernel/state-dir";
import {Effect, FileSystem, Schema} from "effect";

export const DeskRecord = Schema.Struct({
	version: Schema.Literal(1),
	/** The desk's process id, so a record whose process is gone is stale without a network call. */
	pid: Schema.Int,
	/** The page's `localhost` URL, as the desk printed it. */
	page: Schema.String,
});
export type DeskRecord = typeof DeskRecord.Type;

/** What reading the record found. `Unreadable` is a file nothing can trust, so it reads as stale. */
export type DeskRecordRead =
	| {readonly _tag: "Absent"}
	| {readonly _tag: "Found"; readonly record: DeskRecord}
	| {readonly _tag: "Unreadable"; readonly reason: string};

/** The record: `<home>/.tuval/desk.json`. */
export const deskRecordFile = (home: string): string => join(homeTuvalDir(home), "desk.json");

const RecordFile = Schema.fromJsonString(DeskRecord, {space: "\t"});
const encodeRecord = Schema.encodeSync(RecordFile);
const decodeRecord = Schema.decodeUnknownEffect(RecordFile);

export const readDeskRecord = Effect.fn("Tuval.readDeskRecord")(function* (home: string) {
	const fs = yield* FileSystem.FileSystem;
	const file = deskRecordFile(home);
	const text = yield* fs.readFileString(file).pipe(Effect.result);
	if (text._tag === "Failure") {
		const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => true));
		return exists
			? ({_tag: "Unreadable", reason: text.failure.message} satisfies DeskRecordRead)
			: ({_tag: "Absent"} satisfies DeskRecordRead);
	}
	return yield* decodeRecord(text.success).pipe(
		Effect.map((record): DeskRecordRead => ({_tag: "Found", record})),
		Effect.orElseSucceed(
			(): DeskRecordRead => ({_tag: "Unreadable", reason: "it is not a desk record"}),
		),
	);
});

/**
 * Write the record whole, through a sibling temp file and a rename, so a reader never sees half of
 * one. It replaces whatever record was there: the caller has already found that desk gone.
 */
export const writeDeskRecord = Effect.fn("Tuval.writeDeskRecord")(function* (
	home: string,
	record: DeskRecord,
) {
	const fs = yield* FileSystem.FileSystem;
	const file = deskRecordFile(home);
	yield* fs.makeDirectory(homeTuvalDir(home), {recursive: true});
	const temp = `${file}.${record.pid}.tmp`;
	yield* fs.writeFileString(temp, `${encodeRecord(record)}\n`);
	yield* fs.rename(temp, file);
});

/**
 * Remove the record if it is still the one `owner` names: a pid for a record that decoded, `null`
 * for one that did not. A desk stopping takes only its own record away, so a desk started after it,
 * whose record replaced this one, stays findable; a stale record is cleared only if nothing
 * replaced it in the meantime.
 */
export const removeDeskRecord = Effect.fn("Tuval.removeDeskRecord")(function* (
	home: string,
	owner: number | null,
) {
	const fs = yield* FileSystem.FileSystem;
	const read = yield* readDeskRecord(home);
	const ours =
		read._tag === "Found"
			? read.record.pid === owner
			: read._tag === "Unreadable" && owner === null;
	if (ours) yield* fs.remove(deskRecordFile(home), {force: true});
});

/** Advertise the running desk for as long as the caller's scope is open. */
export const advertiseDesk = (home: string, page: string) =>
	Effect.acquireRelease(writeDeskRecord(home, {version: 1, pid: process.pid, page}), () =>
		Effect.ignore(removeDeskRecord(home, process.pid)),
	);
