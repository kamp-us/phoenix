/**
 * `table flags` — what the next table must look at, read-only.
 *
 * It reads the rows the way `table sync` does, then the three facts the table-wide flags need: the
 * control-plane set a `bet` is judged against, the active campaigns, and this week's spend by
 * issue. It writes nothing: a flag is a question for the table, and a `bet` set by someone outside
 * the control-plane set is left exactly as it was set.
 *
 * Naming issues narrows the run to the rows they reach, and then the table-wide checks are not asked,
 * because a campaign count and a share of the week's spend are facts about the whole table.
 *
 * The week the shares are judged over is the 7 days that end at the next table day — the week that
 * table looks back on — and which table it is counts the distinct Table day dates before it.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 * @ruling https://github.com/kamp-us/phoenix/issues/9989
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {parseCampaigns} from "../build/scope-admission.ts";
import {locateRoadmap} from "../campaign/guards.ts";
import {appetiteSizesKey} from "../config/keys/appetite-sizes.ts";
import {type Boards, boardsKey} from "../config/keys/boards.ts";
import {type TableSettings, tableKey} from "../config/keys/table.ts";
import {readKey} from "../config/read-key.ts";
import {exists, readFile} from "../io/fs.ts";
import {type Attempt, fail, ok} from "../io/git.ts";
import {getIssue, type ListedIssue, listOpenIssueFacts, resolveRepo} from "../io/issues.ts";
import {withProjects} from "../io/projects.ts";
import {controlPlaneRoster} from "../ship/roster.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import type {LaneRecord} from "../wire/lane-record.ts";
import {tableDayOf} from "./agenda.ts";
import {BET_STAGE} from "./bets.ts";
import {CONFIG_MALFORMED, PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	type Campaigns,
	type Deciders,
	type Flag,
	flagName,
	flagsOf,
	NOT_ASKED,
	type OnCallRead,
	recOf,
	type ShareWeek,
	weekLanes,
} from "./flags.ts";
import {readHeads} from "./flags-read.ts";
import {onCallItemsOf, readOnCall} from "./on-call-prep.ts";
import type {Row} from "./sync.ts";
import {locateTable, syncBoard, type TableBoard} from "./sync-verb.ts";
import {
	nextTableDay,
	parseTableDay,
	type TableClock,
	type TableDay,
	tableNumber,
	weekBefore,
} from "./table-day.ts";

const VERB = "table flags";

/** Every read the verb makes, passed in so it stays provable offline. */
export interface FlagsBoard<R> extends TableBoard<R> {
	readonly labels: (
		repo: string,
		issue: number,
	) => Effect.Effect<Attempt<ReadonlyArray<string>>, never, R>;
	readonly deciders: (repo: string) => Effect.Effect<Deciders, never, R>;
	readonly campaigns: (cwd: string) => Effect.Effect<Campaigns, never, R>;
	/** Every open issue in the repository: which on-call items are still waiting. */
	readonly openIssues: (
		repo: string,
	) => Effect.Effect<Attempt<ReadonlyArray<ListedIssue>>, never, R>;
}

export interface FlagsOptions<R> {
	readonly repo: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The issues to flag; empty flags the whole table. */
	readonly issues: ReadonlyArray<number>;
	readonly now: Date;
	readonly board: FlagsBoard<R>;
}

interface ShareWindow {
	readonly start: string;
	readonly end: string;
	/** Which table this is: 1 for the first. */
	readonly table: number;
}

/**
 * The week the table-wide shares are judged over: the 7 days that end at the next table day. Its
 * number counts the distinct Table day dates on the board before that day.
 */
export const shareWindow = (
	settings: TableClock,
	rows: ReadonlyMap<number, Row>,
	now: Date,
): ShareWindow => {
	const day = nextTableDay(settings, now);
	const dated = [...rows.values()].flatMap((row): ReadonlyArray<TableDay> => {
		const cell = tableDayOf(row);
		const parsed = cell === null ? null : parseTableDay(cell);
		return parsed === null ? [] : [parsed];
	});
	return {...weekBefore(day, settings.timeZone), table: tableNumber(dated, day)};
};

/**
 * The week the share is judged over, and which of its lanes were fabrika's own work. With no
 * `table.fabrikaShare.labels` the check is off, not unread, so it is `NotAsked`.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10085
 */
const readShare = <R>(
	board: FlagsBoard<R>,
	repo: string,
	rows: ReadonlyMap<number, Row>,
	settings: TableSettings,
	records: ReadonlyMap<number, ReadonlyArray<LaneRecord>>,
	now: Date,
): Effect.Effect<ShareWeek, never, R> =>
	Effect.gen(function* () {
		const unread = (reason: string): ShareWeek => ({_tag: "Unread", reason});
		const labels = settings.fabrikaShare.labels;
		if (labels.length === 0) return NOT_ASKED;
		const week = shareWindow(settings, rows, now);
		const {start, end} = week;
		const fabrika = new Set<number>();
		for (const issue of weekLanes(records, {start, end}).keys()) {
			const carried = yield* board.labels(repo, issue);
			if (carried._tag === "Failure") {
				return unread(`cannot read #${issue}'s labels: ${carried.reason}`);
			}
			if (carried.value.some((label) => labels.includes(label))) fabrika.add(issue);
		}
		return {_tag: "Week", ...week, fabrika};
	});

/** The on-call board as the whole-table run judges it; `NotAsked` with one board. */
const readOnCallFlags = <R>(
	board: FlagsBoard<R>,
	repo: string,
	rows: ReadonlyMap<number, Row>,
	settings: TableSettings,
	boards: Boards,
	now: Date,
): Effect.Effect<OnCallRead, never, R> =>
	Effect.gen(function* () {
		const read = yield* readOnCall(board, VERB, repo, boards);
		if (read._tag === "One") return NOT_ASKED;
		if (read._tag === "Refused") return {_tag: "Unread", reason: read.reason};
		const listing = yield* board.openIssues(repo);
		if (listing._tag === "Failure") {
			return {_tag: "Unread", reason: `cannot read ${repo}'s open issues: ${listing.reason}`};
		}
		const open = new Map(listing.value.map((issue) => [issue.number, issue] as const));
		const {start, end} = shareWindow(settings, rows, now);
		return {
			_tag: "OnCall",
			settings: read.settings,
			issues: new Set(read.rows.keys()),
			open: onCallItemsOf(read.rows, open, [], read.settings, now),
			week: {_tag: "Week", start, end},
		};
	});

const flagJson = (flag: Flag, settings: TableSettings) => {
	const {_tag, ...fields} = flag;
	return {flag: flagName(flag), ...fields, rec: recOf(flag, settings)};
};

const flagLine = (flag: Flag, settings: TableSettings): string =>
	"head" in flag
		? `${VERB}: #${flag.head} ${flagName(flag)}: ${recOf(flag, settings)}`
		: flag._tag === "PastTarget"
			? `${VERB}: #${flag.issue} ${flagName(flag)}: ${recOf(flag, settings)}`
			: `${VERB}: ${flagName(flag)}: ${recOf(flag, settings)}`;

export const runFlags = <R>(
	options: FlagsOptions<R>,
): Effect.Effect<
	VerbOutcome,
	never,
	R | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const settings = yield* readKey(options.cwd, tableKey);
		if (settings._tag === "Refused") {
			return refuse(CONFIG_MALFORMED, `${VERB}: ${settings.reason}. Nothing was read from GitHub.`);
		}
		const sizes = yield* readKey(options.cwd, appetiteSizesKey);
		if (sizes._tag === "Refused") {
			return refuse(CONFIG_MALFORMED, `${VERB}: ${sizes.reason}. Nothing was read from GitHub.`);
		}
		const boards = yield* readKey(options.cwd, boardsKey);
		if (boards._tag === "Refused") {
			return refuse(CONFIG_MALFORMED, `${VERB}: ${boards.reason}. Nothing was read from GitHub.`);
		}
		const resolved = yield* resolveRepo(options.repo, options.env);
		if (resolved._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: no --repo, no CLAUDE_PIPELINE_REPO, no GITHUB_REPOSITORY and no readable origin remote — no repository to flag the table of.`,
			);
		}
		const repo = resolved.value;
		const {board, now} = options;
		const heads = yield* readHeads(board, VERB, repo, settings.value, options.issues);
		if (heads._tag === "Refused") return refuse(heads.code, heads.reason);

		const whole = options.issues.length === 0;
		const deciders: Deciders = heads.rows.some((row) => row.stage?.name === BET_STAGE)
			? yield* board.deciders(repo)
			: NOT_ASKED;
		const campaigns: Campaigns = whole ? yield* board.campaigns(options.cwd) : NOT_ASKED;
		const share: ShareWeek = whole
			? yield* readShare(board, repo, heads.table, settings.value, heads.records, now)
			: NOT_ASKED;
		const onCall: OnCallRead = whole
			? yield* readOnCallFlags(board, repo, heads.table, settings.value, boards.value, now)
			: NOT_ASKED;
		const report = flagsOf({
			settings: settings.value,
			sizes: sizes.value,
			now,
			rows: heads.rows,
			records: heads.records,
			deciders,
			campaigns,
			share,
			onCall,
		});

		const {project} = heads;
		return answer(
			`${JSON.stringify({
				answer: report.flags.length > 0 ? "flagged" : "clear",
				repo,
				project: {number: project.number, title: project.title, url: project.url},
				scope: whole ? "table" : "issues",
				rows: heads.rows.map((row) => row.group.head),
				flags: report.flags.map((flag) => flagJson(flag, settings.value)),
				unread: report.unread,
			})}\n`,
			[
				`${VERB}: read ${settings.note}; ${sizes.note}.`,
				`${VERB}: project #${project.number} "${project.title}" (${project.url}); ${heads.rows.length} row(s) judged${whole ? "" : " — the named issues only, so the campaign, fabrika share and on-call checks were not asked"}.`,
				...report.flags.map((flag) => flagLine(flag, settings.value)),
				...report.unread.map(
					(one) =>
						`${VERB}: ${one.check}${one.issue === null ? "" : ` on #${one.issue}`} unread: ${one.reason}.`,
				),
				...(report.flags.length === 0 ? [`${VERB}: nothing is flagged.`] : []),
			],
		);
	});

/** The active campaigns off the repo's roadmap. An absent roadmap declares none. */
const readActiveCampaigns = (
	cwd: string,
): Effect.Effect<Campaigns, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const located = yield* locateRoadmap(VERB, cwd, null);
		if (located._tag === "Refused") {
			return {_tag: "Unread", reason: located.outcome.stderr.join(" ")};
		}
		const {path, display} = located.located;
		const present = yield* Effect.result(exists(path));
		if (present._tag === "Failure") {
			return {_tag: "Unread", reason: `cannot probe ${display}: ${present.failure.reason}`};
		}
		if (!present.success) return {_tag: "Read", active: []};
		const text = yield* Effect.result(readFile(path));
		if (text._tag === "Failure") {
			return {_tag: "Unread", reason: `cannot read ${display}: ${text.failure.reason}`};
		}
		const table = parseCampaigns(text.success);
		if (table._tag === "Malformed") {
			return {_tag: "Unread", reason: `${display}: ${table.reason}`};
		}
		return {
			_tag: "Read",
			active: table.rows.filter((row) => row.state === "active").map((row) => row.name),
		};
	});

/** The shipped board: GitHub under the ambient token, and the roadmap in this checkout. */
export const flagsBoard: FlagsBoard<
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = {
	locate: (repo, target) => withProjects((token) => locateTable(token, repo, target, VERB)),
	items: syncBoard.items,
	node: syncBoard.node,
	comments: syncBoard.comments,
	labels: (repo, issue) =>
		Effect.map(getIssue(repo, issue), (found) =>
			found._tag === "Present"
				? ok(found.value.labels)
				: fail(found._tag === "Unknown" ? found.reason : `#${issue} is no issue`),
		),
	deciders: (repo) =>
		Effect.map(
			controlPlaneRoster(repo),
			(roster): Deciders =>
				roster._tag === "Roster"
					? {_tag: "Roster", logins: roster.logins}
					: {_tag: "Unread", reason: `cannot read the control-plane set: ${roster.reason}`},
		),
	campaigns: readActiveCampaigns,
	openIssues: listOpenIssueFacts,
};
