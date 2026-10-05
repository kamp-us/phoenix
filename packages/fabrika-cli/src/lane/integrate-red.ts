/**
 * What `lane integrate` saw when a code validator went red — kept beside the lane's log, so the next
 * reader of the lane learns which validator failed and how, without having seen integrate's stderr.
 *
 * Integrate runs in the driver's shell and a repair builder runs in another, so the refusal's stderr
 * never reaches the one reader who has to fix it. Two builders on one epic run could not tell which
 * validator had failed and guessed. So every red run leaves one record in `integrate-red.jsonl` in the
 * lane's directory, and `lane report` copies the matching record onto the ledger line it appends:
 * `build claim` reads that line back.
 *
 * The record is also the proof a red base earns its lap. Integrate re-runs the failed validator over
 * the pre-merge head before it answers, and only the record says what that re-run found — so
 * `lane report` takes the lap off the record and never off a driver's word.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10257#issuecomment-5974130674
 */
import {Effect, type FileSystem, Path, Result} from "effect";
import {appendText, readFile} from "../io/fs.ts";
import {type Instant, instant} from "../wire/lane-record.ts";

/** The record file's name inside the lane directory, beside `events.jsonl`. */
export const INTEGRATE_RED_FILE = "integrate-red.jsonl";

/**
 * The non-blank lines kept from each stream. A task runner prints its failures last, so the kept
 * lines are the stream's end, never its start.
 */
export const KEPT_LINES = 40;

/** The end of one output stream, and how many non-blank lines before it were dropped. */
export interface StreamTail {
	readonly lines: ReadonlyArray<string>;
	readonly omitted: number;
}

/**
 * Both streams' ends, each kept on its own. A validator that writes a warning to stderr and its test
 * failures to stdout loses neither, because neither stream's tail is measured against the other's.
 */
export interface KeptOutput {
	readonly stdout: StreamTail;
	readonly stderr: StreamTail;
}

/** One red validator run: the command that failed, as one line, and what it printed. */
export interface RedRun {
	readonly validator: string;
	readonly output: KeptOutput;
}

const tail = (text: string): StreamTail => {
	const lines = text.split("\n").filter((line) => line.trim() !== "");
	const kept = lines.slice(-KEPT_LINES);
	return {lines: kept, omitted: lines.length - kept.length};
};

export const keepOutput = (stdout: string, stderr: string): KeptOutput => ({
	stdout: tail(stdout),
	stderr: tail(stderr),
});

/** The kept output as stderr lines a refusal prints, each stream labelled and its cut named. */
export const describeOutput = (output: KeptOutput): ReadonlyArray<string> =>
	(["stderr", "stdout"] as const).flatMap((stream) => {
		const kept = output[stream];
		if (kept.lines.length === 0) return [];
		return [
			kept.omitted === 0
				? `--- ${stream} ---`
				: `--- ${stream} (last ${kept.lines.length} line(s); ${kept.omitted} earlier line(s) dropped) ---`,
			...kept.lines,
		];
	});

/**
 * What the failed validator did over the pre-merge assembly head. `green` charges the child: the
 * merge is what broke it. `red` is machinery: the base was already broken, and its output is what
 * whoever fixes the base reads.
 */
export type BaseRun =
	| {readonly verdict: "green"}
	| {readonly verdict: "red"; readonly output: KeptOutput};

export interface IntegrateRedRecord {
	readonly at: Instant;
	/** The child's branch, exactly as `lane integrate --child` named it. */
	readonly child: string;
	/** The pre-merge assembly head both runs were judged against, and the one the seat is back at. */
	readonly head: string;
	/** The validator that went red over the merged tree, and its output there. */
	readonly merged: RedRun;
	readonly base: BaseRun;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isStreamTail = (value: unknown): value is StreamTail =>
	isRecord(value) &&
	Array.isArray(value.lines) &&
	value.lines.every((line) => typeof line === "string") &&
	typeof value.omitted === "number" &&
	Number.isInteger(value.omitted) &&
	value.omitted >= 0;

export const isKeptOutput = (value: unknown): value is KeptOutput =>
	isRecord(value) && isStreamTail(value.stdout) && isStreamTail(value.stderr);

export const isRedRun = (value: unknown): value is RedRun =>
	isRecord(value) &&
	typeof value.validator === "string" &&
	value.validator.trim() !== "" &&
	isKeptOutput(value.output);

const SHA = /^[0-9a-f]{7,40}$/;

const decodeBase = (value: unknown): BaseRun | null => {
	if (!isRecord(value)) return null;
	if (value.verdict === "green") return {verdict: "green"};
	if (value.verdict === "red" && isKeptOutput(value.output)) {
		return {verdict: "red", output: value.output};
	}
	return null;
};

const decodeRecord = (value: unknown): IntegrateRedRecord | null => {
	if (!isRecord(value)) return null;
	const at = instant(typeof value.at === "string" ? value.at : "");
	const base = decodeBase(value.base);
	if (
		at === null ||
		base === null ||
		typeof value.child !== "string" ||
		value.child === "" ||
		typeof value.head !== "string" ||
		!SHA.test(value.head) ||
		!isRedRun(value.merged)
	) {
		return null;
	}
	return {at, child: value.child, head: value.head, merged: value.merged, base};
};

export type RedRecordsParse =
	| {readonly _tag: "Parsed"; readonly records: ReadonlyArray<IntegrateRedRecord>}
	| {readonly _tag: "Malformed"; readonly defects: ReadonlyArray<string>};

/** Parse the file's text. A line that does not decode is a defect, never a skipped record. */
export const parseRedRecords = (text: string): RedRecordsParse => {
	const records: IntegrateRedRecord[] = [];
	const defects: string[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (line.trim() === "") continue;
		const parsed = Result.try({try: (): unknown => JSON.parse(line), catch: () => null});
		const record = Result.isFailure(parsed) ? null : decodeRecord(parsed.success);
		if (record === null) {
			defects.push(`${INTEGRATE_RED_FILE} line ${index + 1} is not an integrate red record`);
		} else {
			records.push(record);
		}
	}
	return defects.length > 0 ? {_tag: "Malformed", defects} : {_tag: "Parsed", records};
};

export const encodeRedRecord = (record: IntegrateRedRecord): string =>
	`${JSON.stringify(record)}\n`;

/** Append one record in the lane directory `dir`; the caller holds the ledger lock. */
export const appendRedRecord = (dir: string, record: IntegrateRedRecord) =>
	Effect.gen(function* () {
		const path = (yield* Path.Path).join(dir, INTEGRATE_RED_FILE);
		return yield* Effect.result(appendText(path, encodeRedRecord(record)));
	});

export type RedRecordsLoad =
	| {readonly _tag: "Loaded"; readonly records: ReadonlyArray<IntegrateRedRecord>}
	| {readonly _tag: "Unreadable"; readonly path: string; readonly reason: string};

/** Read a lane's red records. An absent file is a lane with none, never a fault. */
export const loadRedRecords = (
	dir: string,
): Effect.Effect<RedRecordsLoad, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = (yield* Path.Path).join(dir, INTEGRATE_RED_FILE);
		const text = yield* Effect.result(readFile(path));
		if (Result.isFailure(text)) {
			return text.failure.notFound
				? ({_tag: "Loaded", records: []} as const)
				: ({_tag: "Unreadable", path, reason: text.failure.reason} as const);
		}
		const parsed = parseRedRecords(text.success);
		return parsed._tag === "Malformed"
			? ({_tag: "Unreadable", path, reason: parsed.defects.join("; ")} as const)
			: ({_tag: "Loaded", records: parsed.records} as const);
	});

/**
 * The latest record integrate wrote for this child against this assembly head, or `null`.
 *
 * `head` may be the short sha a driver copied off the refusal, so it matches as a prefix of the full
 * sha the record holds. `child` is the issue the ledger task names: a record is this task's only when
 * its branch was cut for that issue (`build/<n>-…`), so two children refused against one head never
 * read each other's output.
 */
export const latestRedRecord = (
	records: ReadonlyArray<IntegrateRedRecord>,
	head: string,
	child: number,
): IntegrateRedRecord | null =>
	records.findLast(
		(record) => record.head.startsWith(head) && record.child.startsWith(`build/${child}-`),
	) ?? null;
