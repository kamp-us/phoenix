import {Effect, FileSystem, Path, Result, Schema} from "effect";
import {appendFile} from "../io/fs.ts";
import {type LedgerRow, readSpendLedger} from "./ledger.ts";
import {
	decodeUsageRecord,
	parseUsageRecord,
	recordKey,
	refinesIssue,
	sameRecord,
	USAGE_RECORD_VERSION,
	type UsageRecord,
} from "./usage-record.ts";

export const readUsageLedger = (text: string) => {
	const records: UsageRecord[] = [];
	const legacy: LedgerRow[] = [];
	let malformed = 0;
	let newerVersion = 0;
	let duplicates = 0;
	let conflicts = 0;
	const identities = new Map<string, UsageRecord[]>();
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		const record = parseUsageRecord(line);
		if (Result.isSuccess(record)) {
			const key = recordKey(record.success);
			const prior = identities.get(key) ?? [];
			if (prior.some((row) => sameRecord(row, record.success) || refinesIssue(row, record.success)))
				duplicates++;
			else {
				const replaced = prior.filter((row) => refinesIssue(record.success, row));
				for (const row of replaced) records.splice(records.indexOf(row), 1);
				const remaining = prior.filter((row) => !replaced.includes(row));
				if (remaining.length > 0) conflicts++;
				identities.set(key, [...remaining, record.success]);
				records.push(record.success);
			}
		} else {
			const historical = readSpendLedger(line);
			legacy.push(...historical.rows);
			const version = Result.try({try: (): unknown => JSON.parse(line)?.v, catch: () => null});
			if (historical.rows.length > 0) continue;
			if (
				Result.isSuccess(version) &&
				typeof version.success === "number" &&
				Number.isSafeInteger(version.success) &&
				version.success > USAGE_RECORD_VERSION
			)
				newerVersion++;
			else malformed++;
		}
	}
	return {records, legacy, diagnostics: {malformed, newerVersion, duplicates, conflicts}};
};

class RecordingFailed extends Schema.TaggedErrorClass<RecordingFailed>()("spend/RecordingFailed", {
	reason: Schema.String,
}) {}

const acquire = Effect.fn("spend.acquire")(function* (lock: string) {
	const fs = yield* FileSystem.FileSystem;
	for (let attempt = 0; attempt < 100; attempt++) {
		const made = yield* Effect.result(fs.makeDirectory(lock));
		if (Result.isSuccess(made)) return;
		if (made.failure.reason._tag !== "AlreadyExists") return yield* made.failure;
		yield* Effect.sleep("50 millis");
	}
	return yield* new RecordingFailed({
		reason:
			"Recorder lock is held; retry after its owner releases it. A stopped owner's lock requires explicit removal.",
	});
});

export const recordUsage = Effect.fn("spend.recordUsage")(
	function* (requestedPath: string, input: UsageRecord) {
		const decoded = decodeUsageRecord(input);
		if (Result.isFailure(decoded))
			return yield* new RecordingFailed({reason: "Invalid usage record; nothing appended."});
		const record = decoded.success;
		const fs = yield* FileSystem.FileSystem;
		const paths = yield* Path.Path;
		yield* fs.makeDirectory(paths.dirname(requestedPath), {recursive: true});
		const path = (yield* fs.exists(requestedPath))
			? yield* fs.realPath(requestedPath)
			: paths.join(yield* fs.realPath(paths.dirname(requestedPath)), paths.basename(requestedPath));
		const lock = `${path}.lock`;
		let released = true;
		const result = yield* Effect.scoped(
			Effect.gen(function* () {
				yield* Effect.acquireRelease(acquire(lock), () =>
					fs.remove(lock, {recursive: true}).pipe(
						Effect.catch(() =>
							Effect.sync(() => {
								released = false;
							}),
						),
					),
				);
				const before = (yield* fs.exists(path)) ? yield* fs.readFileString(path) : "";
				const old = readUsageLedger(before).records.filter(
					(row) => recordKey(row) === recordKey(record),
				);
				if (
					old.some(
						(row) =>
							!sameRecord(row, record) && !refinesIssue(row, record) && !refinesIssue(record, row),
					)
				)
					return yield* new RecordingFailed({
						reason: "Conflicting usage for the same identity; existing data retained.",
					});
				const duplicate = old.some((row) => sameRecord(row, record) || refinesIssue(row, record));
				if (!duplicate) yield* appendFile(path, `${JSON.stringify(record)}\n`);
				const file = yield* fs.open(path, {flag: "a"});
				yield* file.sync;
				const landed = readUsageLedger(yield* fs.readFileString(path)).records.some(
					(row) =>
						recordKey(row) === recordKey(record) &&
						(sameRecord(row, record) || refinesIssue(row, record)),
				);
				if (!landed)
					return yield* new RecordingFailed({
						reason: "Appended usage could not be read back; retry this record.",
					});
				return {status: duplicate ? ("duplicate" as const) : ("recorded" as const)};
			}),
		);
		if (!released)
			return yield* new RecordingFailed({
				reason:
					"Usage was persisted but the recorder lock could not be released; remove it after this recorder stops.",
			});
		return result;
	},
	Effect.catch((failure) =>
		Effect.succeed({
			status: "failed" as const,
			notice: `${failure._tag === "spend/RecordingFailed" ? failure.reason : "Usage ledger IO failed; retry this record."} The task result is unchanged.`,
		}),
	),
);

export const loadUsageLedger = Effect.fn("spend.loadUsageLedger")(function* (path: string) {
	const fs = yield* FileSystem.FileSystem;
	return readUsageLedger(yield* fs.readFileString(path));
});
