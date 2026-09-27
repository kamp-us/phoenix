/**
 * The `lane-record` marker comment — what one lane did, posted to its issue when it reaches a
 * terminal state.
 *
 *     lane-record: #<issue> complete @ 2026-09-26T10:00:00.000Z
 *
 *     | Field | Value |
 *     | --- | --- |
 *     | Outcome | complete |
 *     | Wall-clock | 3h 12m — from 2026-09-26T06:48:00.000Z to 2026-09-26T10:00:00.000Z |
 *     | Builds | 1 |
 *     …
 *
 *     <details>
 *     <summary>Lane log — 6 events</summary>
 *     …
 *     </details>
 *
 * The lane ledger lives in one machine's gitignored `.fabrika/lanes/`, so this comment is the only
 * copy of a lane's history anyone else can read. The first line is the key a terminal is recorded
 * under — issue, terminal state and the instant the terminal event was appended — which is what
 * lets `lane record` answer "already posted" for a repeat run instead of stacking a second record.
 *
 * Two rows are derived facts rather than independent ones, and the reader holds them to it: `Asks`
 * must equal the parks routed `founder`, and `Wall-clock` must be the span its own `from`/`to`
 * state. A record where they disagree is `Malformed`, never a record carrying two numbers.
 */

import type {NonEmptyReadonlyArray, WireEmit, WireRead, WireReadLines} from "./format.ts";
import {absent, firstNonBlankLine, malformed, reachesFor} from "./grill-marker.ts";

/** The key that names these bytes. */
export const KEY = "lane-record";

declare const INSTANT: unique symbol;

/** An ISO-8601 date or UTC instant. Branded so a record cannot carry a time nobody can compare. */
export type Instant = string & {readonly [INSTANT]: true};

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

export const instant = (raw: string): Instant | null => {
	const value = raw.trim();
	return INSTANT_RE.test(value) && !Number.isNaN(Date.parse(value)) ? (value as Instant) : null;
};

/**
 * Where a lane came from. `driver-pick` is the default: a lane nobody said otherwise about was
 * picked by its driver.
 */
export const ORIGINS = [
	"bet",
	"founder-start",
	"driver-pick",
	"experiment",
	"mid-lane-fix",
] as const;
export type Origin = (typeof ORIGINS)[number];
export const DEFAULT_ORIGIN: Origin = "driver-pick";

export const origin = (raw: string): Origin | null => {
	const value = raw.trim().toLowerCase();
	return (ORIGINS as ReadonlyArray<string>).includes(value) ? (value as Origin) : null;
};

/** Whose act a park waits on — the same two routes `lane/report.ts`'s cause table names. */
export type Route = "driver" | "founder";

export interface Park {
	readonly task: string;
	readonly leaf: string;
	/** The closed-set park cause, or `null` for a park nothing named. */
	readonly cause: string | null;
	readonly route: Route;
	readonly at: Instant;
}

/** Dollars, or the reason there is no dollar figure. There is no measured zero standing in for "unread". */
export type Spent =
	| {readonly _tag: "Measured"; readonly usd: number}
	| {readonly _tag: "Unmeasured"; readonly reason: string};

export type Waiting =
	| {readonly _tag: "None"}
	| {readonly _tag: "Until"; readonly on: string; readonly until: Instant};

export interface LaneRecord {
	readonly issue: number;
	/** The terminal state the lane folded to. */
	readonly outcome: string;
	readonly startedAt: Instant;
	/** When the event that ended the lane was appended — half of the record's key. */
	readonly terminalAt: Instant;
	readonly builds: number;
	readonly reviews: number;
	readonly parks: ReadonlyArray<Park>;
	readonly spent: Spent;
	readonly origin: Origin;
	readonly waiting: Waiting;
	readonly prs: ReadonlyArray<number>;
	/** The lane's `events.jsonl`, one event per line. */
	readonly log: ReadonlyArray<string>;
}

export type LaneRecordRead = WireRead<LaneRecord>;

/** Every park a founder had to answer — the lane's asks. */
export const asksOf = (record: Pick<LaneRecord, "parks">): number =>
	record.parks.filter((park) => park.route === "founder").length;

export const wallClockSeconds = (record: Pick<LaneRecord, "startedAt" | "terminalAt">): number =>
	Math.max(0, Math.round((Date.parse(record.terminalAt) - Date.parse(record.startedAt)) / 1000));

/** Whether two records stand for the same terminal of the same lane. */
export const sameTerminal = (a: LaneRecord, b: LaneRecord): boolean =>
	a.issue === b.issue && a.outcome === b.outcome && a.terminalAt === b.terminalAt;

export const humanDuration = (seconds: number): string => {
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
};

const ROWS = [
	"Outcome",
	"Wall-clock",
	"Builds",
	"Reviews",
	"Parks",
	"Spent $",
	"Asks",
	"Origin",
	"Waiting",
	"PRs",
] as const;
type Row = (typeof ROWS)[number];

const UNCAUSED = "uncaused";
const NONE = "none";
const UNMEASURED = "unmeasured — ";

const escapeCell = (text: string): string => text.replace(/\|/g, "\\|");
const unescapeCell = (text: string): string => text.replace(/\\\|/g, "|");

const renderPark = (park: Park): string =>
	`\`${park.leaf}\` on ${park.task} (${park.cause ?? UNCAUSED}, ${park.route}) at ${park.at}`;

const renderSpent = (spent: Spent): string =>
	spent._tag === "Measured" ? `$${spent.usd.toFixed(2)}` : `${UNMEASURED}${spent.reason}`;

const renderWaiting = (waiting: Waiting): string =>
	waiting._tag === "None" ? NONE : `on ${waiting.on} until ${waiting.until}`;

/** A fence longer than any backtick run in the log, so a log line can never close it. */
const fenceFor = (lines: ReadonlyArray<string>): string => {
	const longest = Math.max(
		0,
		...lines.flatMap((line) => (line.match(/`+/g) ?? []).map((run) => run.length)),
	);
	return "`".repeat(Math.max(3, longest + 1));
};

/** Compose the comment's bytes. Round-trips through {@link read}. */
export const emit = (record: LaneRecord): string => {
	const seconds = wallClockSeconds(record);
	const cells: Record<Row, string> = {
		Outcome: record.outcome,
		"Wall-clock": `${humanDuration(seconds)} — from ${record.startedAt} to ${record.terminalAt}`,
		Builds: String(record.builds),
		Reviews: String(record.reviews),
		Parks: record.parks.length === 0 ? NONE : record.parks.map(renderPark).join("; "),
		"Spent $": renderSpent(record.spent),
		Asks: String(asksOf(record)),
		Origin: record.origin,
		Waiting: renderWaiting(record.waiting),
		PRs: record.prs.length === 0 ? NONE : record.prs.map((pr) => `#${pr}`).join(", "),
	};
	const fence = fenceFor(record.log);
	return [
		`${KEY}: #${record.issue} ${record.outcome} @ ${record.terminalAt}`,
		"",
		"| Field | Value |",
		"| --- | --- |",
		...ROWS.map((row) => `| ${row} | ${escapeCell(cells[row])} |`),
		"",
		"<details>",
		`<summary>Lane log — ${record.log.length} events</summary>`,
		"",
		`${fence}jsonl`,
		...record.log,
		fence,
		"",
		"</details>",
		"",
	].join("\n");
};

const MARKER = /^lane-record:\s*#(\d+)\s+(\S+)\s+@\s+(\S+)\s*$/;
const TABLE_ROW = /^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|$/;
const WALL_CLOCK = /^(.+?) — from (\S+) to (\S+)$/;
const PARK = /^`([^`]+)` on (\S+) \(([^,]+), (driver|founder)\) at (\S+)$/;
const COUNT = /^\d+$/;

type Parsed<A> =
	| {readonly ok: true; readonly value: A}
	| {readonly ok: false; readonly reason: string};
const good = <A>(value: A): Parsed<A> => ({ok: true, value});
const bad = <A>(reason: string): Parsed<A> => ({ok: false, reason});

const parseCount = (row: Row, cell: string): Parsed<number> =>
	COUNT.test(cell) ? good(Number(cell)) : bad(`the ${row} row "${cell}" is not a whole count`);

const parseParks = (cell: string): Parsed<ReadonlyArray<Park>> => {
	if (cell === NONE) return good([]);
	const parks: Park[] = [];
	for (const item of cell.split("; ")) {
		const matched = PARK.exec(item);
		const at = instant(matched?.[5] ?? "");
		if (matched === null || at === null) {
			return bad(
				`the park "${item}" is not "\`<leaf>\` on <task> (<cause>, <route>) at <instant>"`,
			);
		}
		const cause = matched[3] ?? UNCAUSED;
		parks.push({
			leaf: matched[1] ?? "",
			task: matched[2] ?? "",
			cause: cause === UNCAUSED ? null : cause,
			route: matched[4] === "founder" ? "founder" : "driver",
			at,
		});
	}
	return good(parks);
};

const parseSpent = (cell: string): Parsed<Spent> => {
	if (cell.startsWith(UNMEASURED)) {
		const reason = cell.slice(UNMEASURED.length).trim();
		return reason === ""
			? bad("the Spent $ row is unmeasured and names no reason")
			: good({_tag: "Unmeasured", reason});
	}
	const matched = /^\$(\d+(?:\.\d+)?)$/.exec(cell);
	return matched === null
		? bad(`the Spent $ row "${cell}" is neither "$<amount>" nor "unmeasured — <reason>"`)
		: good({_tag: "Measured", usd: Number(matched[1])});
};

const parseWaiting = (cell: string): Parsed<Waiting> => {
	if (cell === NONE) return good({_tag: "None"});
	const split = cell.lastIndexOf(" until ");
	const until = split === -1 ? null : instant(cell.slice(split + " until ".length));
	const on = split === -1 ? "" : cell.slice(0, split).replace(/^on /, "").trim();
	if (!cell.startsWith("on ") || until === null || on === "") {
		return bad(`the Waiting row "${cell}" is neither "none" nor "on <what> until <date>"`);
	}
	return good({_tag: "Until", on, until});
};

const parsePrs = (cell: string): Parsed<ReadonlyArray<number>> => {
	if (cell === NONE) return good([]);
	const prs: number[] = [];
	for (const item of cell.split(", ")) {
		const matched = /^#(\d+)$/.exec(item);
		if (matched === null) return bad(`the PRs row names "${item}", which is not "#<number>"`);
		prs.push(Number(matched[1]));
	}
	return good(prs);
};

const parseLog = (lines: ReadonlyArray<string>): Parsed<ReadonlyArray<string>> => {
	const details = lines.indexOf("<details>");
	const summary = /^<summary>Lane log — (\d+) events<\/summary>$/.exec(lines[details + 1] ?? "");
	if (details === -1 || summary === null) {
		return bad(
			'the record carries no collapsed lane log — a <details> block summarised "Lane log — <n> events"',
		);
	}
	const open = lines.findIndex((line, index) => index > details && /^`{3,}jsonl$/.test(line));
	const fence = open === -1 ? "" : (lines[open] ?? "").replace(/jsonl$/, "");
	const close = open === -1 ? -1 : lines.findIndex((line, index) => index > open && line === fence);
	if (close === -1)
		return bad("the lane log's fenced block is not opened with ```jsonl and closed");
	const log = lines.slice(open + 1, close);
	return log.length === Number(summary[1])
		? good(log)
		: bad(`the lane log summary counts ${summary[1]} events and the block holds ${log.length}`);
};

/** Read the marker comment. Total: `Found` | `Absent` | `Malformed`. */
export const read = (artifact: string): LaneRecordRead => {
	if (!reachesFor(artifact, KEY)) {
		return absent(`the first line does not open with "${KEY}:" — no marker of this format`);
	}
	const first = firstNonBlankLine(artifact) ?? "";
	const evidence = `first line: "${first}"`;
	const marker = MARKER.exec(first);
	const terminalAt = instant(marker?.[3] ?? "");
	if (marker === null || terminalAt === null) {
		return malformed(`the marker is not "${KEY}: #<issue> <outcome> @ <instant>"`, evidence);
	}
	const lines = artifact.split("\n").map((line) => line.trimEnd());
	const details = lines.indexOf("<details>");
	const cells = new Map<string, string>();
	for (const line of details === -1 ? lines : lines.slice(0, details)) {
		const row = TABLE_ROW.exec(line.trim());
		if (row === null) continue;
		const name = row[1] ?? "";
		if (!(ROWS as ReadonlyArray<string>).includes(name)) continue;
		if (cells.has(name)) return malformed(`the ${name} row appears twice`, evidence);
		cells.set(name, unescapeCell(row[2] ?? ""));
	}
	const missing = ROWS.filter((row) => !cells.has(row));
	if (missing.length > 0)
		return malformed(`the record carries no ${missing.join(", ")} row`, evidence);
	const cell = (row: Row): string => cells.get(row) ?? "";

	const outcome = marker[2] ?? "";
	if (cell("Outcome") !== outcome) {
		return malformed(
			`the Outcome row "${cell("Outcome")}" disagrees with the marker's "${outcome}"`,
			evidence,
		);
	}
	const wall = WALL_CLOCK.exec(cell("Wall-clock"));
	const startedAt = instant(wall?.[2] ?? "");
	if (wall === null || startedAt === null || wall[3] !== terminalAt) {
		return malformed(
			`the Wall-clock row "${cell("Wall-clock")}" is not "<span> — from <start> to ${terminalAt}"`,
			evidence,
		);
	}
	const builds = parseCount("Builds", cell("Builds"));
	if (!builds.ok) return malformed(builds.reason, evidence);
	const reviews = parseCount("Reviews", cell("Reviews"));
	if (!reviews.ok) return malformed(reviews.reason, evidence);
	const asks = parseCount("Asks", cell("Asks"));
	if (!asks.ok) return malformed(asks.reason, evidence);
	const parks = parseParks(cell("Parks"));
	if (!parks.ok) return malformed(parks.reason, evidence);
	const spent = parseSpent(cell("Spent $"));
	if (!spent.ok) return malformed(spent.reason, evidence);
	const waiting = parseWaiting(cell("Waiting"));
	if (!waiting.ok) return malformed(waiting.reason, evidence);
	const prs = parsePrs(cell("PRs"));
	if (!prs.ok) return malformed(prs.reason, evidence);
	const log = parseLog(lines);
	if (!log.ok) return malformed(log.reason, evidence);
	const originValue = origin(cell("Origin"));
	if (originValue === null) {
		return malformed(
			`the Origin row "${cell("Origin")}" is not one of ${ORIGINS.join(", ")}`,
			evidence,
		);
	}
	const record: LaneRecord = {
		issue: Number(marker[1]),
		outcome,
		startedAt,
		terminalAt,
		builds: builds.value,
		reviews: reviews.value,
		parks: parks.value,
		spent: spent.value,
		origin: originValue,
		waiting: waiting.value,
		prs: prs.value,
		log: log.value,
	};
	if (asksOf(record) !== asks.value) {
		return malformed(
			`the Asks row counts ${asks.value} and the parks name ${asksOf(record)} routed to the founder`,
			evidence,
		);
	}
	const span = humanDuration(wallClockSeconds(record));
	if (wall[1] !== span) {
		return malformed(`the Wall-clock row reads "${wall[1]}" and its own span is ${span}`, evidence);
	}
	return {_tag: "Found", value: record};
};

/** The `wire read` answer: one tab-separated line per field, a line per park, PR and log line. */
export const render = (record: LaneRecord): NonEmptyReadonlyArray<string> => [
	`issue\t${record.issue}`,
	`outcome\t${record.outcome}`,
	`startedAt\t${record.startedAt}`,
	`terminalAt\t${record.terminalAt}`,
	`wallClockSeconds\t${wallClockSeconds(record)}`,
	`builds\t${record.builds}`,
	`reviews\t${record.reviews}`,
	...record.parks.map(
		(park) =>
			`park\t${park.task}\t${park.leaf}\t${park.cause ?? UNCAUSED}\t${park.route}\t${park.at}`,
	),
	record.spent._tag === "Measured"
		? `spent\tmeasured\t${record.spent.usd}`
		: `spent\tunmeasured\t${record.spent.reason}`,
	`asks\t${asksOf(record)}`,
	`origin\t${record.origin}`,
	record.waiting._tag === "None"
		? "waiting\tnone"
		: `waiting\t${record.waiting.on}\t${record.waiting.until}`,
	...record.prs.map((pr) => `pr\t${pr}`),
	...record.log.map((line) => `log\t${line}`),
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
	Number.isInteger(value) && (value as number) >= 0;

/**
 * Decode a record from its JSON shape — `wire emit`'s stdin, and the one gate every composed
 * record passes, so a record the reader would refuse is refused before any bytes exist.
 */
export const decode = (value: unknown): Parsed<LaneRecord> => {
	if (!isRecord(value)) return bad("the record is not a JSON object");
	const startedAt = instant(String(value.startedAt ?? ""));
	const terminalAt = instant(String(value.terminalAt ?? ""));
	const originValue = origin(String(value.origin ?? ""));
	if (!isCount(value.issue) || value.issue === 0) return bad("issue is not an issue number");
	if (typeof value.outcome !== "string" || !/^\S+$/.test(value.outcome)) {
		return bad("outcome is not a terminal state name");
	}
	if (startedAt === null || terminalAt === null)
		return bad("startedAt/terminalAt is not an instant");
	if (Date.parse(startedAt) > Date.parse(terminalAt)) return bad("startedAt is after terminalAt");
	if (!isCount(value.builds) || !isCount(value.reviews))
		return bad("builds/reviews is not a count");
	if (originValue === null) return bad(`origin is not one of ${ORIGINS.join(", ")}`);
	if (!Array.isArray(value.parks)) return bad("parks is not a list");
	const parks: Park[] = [];
	for (const raw of value.parks) {
		const at = isRecord(raw) ? instant(String(raw.at ?? "")) : null;
		if (
			!isRecord(raw) ||
			at === null ||
			typeof raw.task !== "string" ||
			!/^\S+$/.test(raw.task) ||
			typeof raw.leaf !== "string" ||
			!/^[^`\s;]+$/.test(raw.leaf) ||
			(raw.cause !== null && !(typeof raw.cause === "string" && /^[a-z0-9-]+$/.test(raw.cause))) ||
			(raw.route !== "driver" && raw.route !== "founder")
		) {
			return bad("a park is not {task, leaf, cause, route, at}");
		}
		parks.push({
			task: raw.task,
			leaf: raw.leaf,
			cause: raw.cause as string | null,
			route: raw.route,
			at,
		});
	}
	const spentRaw = value.spent;
	let spent: Spent;
	if (
		isRecord(spentRaw) &&
		spentRaw._tag === "Measured" &&
		typeof spentRaw.usd === "number" &&
		spentRaw.usd >= 0
	) {
		spent = {_tag: "Measured", usd: spentRaw.usd};
	} else if (
		isRecord(spentRaw) &&
		spentRaw._tag === "Unmeasured" &&
		typeof spentRaw.reason === "string" &&
		spentRaw.reason.trim() !== "" &&
		!spentRaw.reason.includes("\n")
	) {
		spent = {_tag: "Unmeasured", reason: spentRaw.reason.trim()};
	} else {
		return bad("spent is neither {_tag: Measured, usd} nor {_tag: Unmeasured, reason}");
	}
	const waitingRaw = value.waiting;
	let waiting: Waiting;
	if (isRecord(waitingRaw) && waitingRaw._tag === "None") {
		waiting = {_tag: "None"};
	} else {
		const until = isRecord(waitingRaw) ? instant(String(waitingRaw.until ?? "")) : null;
		const on =
			isRecord(waitingRaw) && typeof waitingRaw.on === "string" ? waitingRaw.on.trim() : "";
		if (!isRecord(waitingRaw) || waitingRaw._tag !== "Until" || until === null || !waitingOn(on)) {
			return bad("waiting is neither {_tag: None} nor {_tag: Until, on, until}");
		}
		waiting = {_tag: "Until", on, until};
	}
	if (!Array.isArray(value.prs) || !value.prs.every((pr) => isCount(pr) && pr > 0)) {
		return bad("prs is not a list of pull request numbers");
	}
	if (
		!Array.isArray(value.log) ||
		!value.log.every((line) => typeof line === "string" && !line.includes("\n"))
	) {
		return bad("log is not a list of single lines");
	}
	return good({
		issue: value.issue,
		outcome: value.outcome,
		startedAt,
		terminalAt,
		builds: value.builds,
		reviews: value.reviews,
		parks,
		spent,
		origin: originValue,
		waiting,
		prs: value.prs as ReadonlyArray<number>,
		log: value.log as ReadonlyArray<string>,
	});
};

/** Whether `on` can stand in the Waiting cell: one non-blank line. */
export const waitingOn = (on: string): boolean => on.trim() !== "" && !/[\n\r]/.test(on);

/** The registry row's byte-level `emit`: the record as JSON on stdin. */
export const emitFromFields = (fields: string): WireEmit => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fields);
	} catch {
		return {
			_tag: "Unusable",
			reason: "the fields are not JSON — pass the record as one JSON object",
		};
	}
	const decoded = decode(parsed);
	return decoded.ok
		? {_tag: "Composed", bytes: emit(decoded.value)}
		: {_tag: "Unusable", reason: decoded.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: render(result.value)} : result;
};
