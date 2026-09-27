/**
 * The outcome check, as data: which shipped bets are due back at the table, the evidence each one
 * carries, and the comment and row cells prep writes for it. Pure — `table prep` does the reads, runs
 * the sources and hands the answers in.
 *
 * The rules it holds:
 * - **Only a bet comes back.** A row is a bet when its Origin reads `bet`, the one cell that says the
 *   work was picked at a table. A row that ran without a bet, such as one sync filed under Outside the
 *   bets and moved to `shipped`, never becomes a check.
 * - **Due is read off the row.** A bet whose Stage has read `shipped` for `table.checkDelayDays`
 *   days is due; the Stage value's own `updatedAt` is when it shipped.
 * - **The evidence needs no config.** Every check carries the pitch's Success line (or says there is
 *   none) and the GitHub signals; fabrika's own numbers join them when the issue is fabrika's work.
 *   A declared evidence source only adds text beside them.
 * - **A source never fails the check.** One that exits non-zero, times out or cannot start is shown
 *   as that, and the check goes on.
 * - **The answer is a person's.** Nothing here writes the Outcome field.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

import {type EvidenceSource, OUTSIDE_THE_BETS, type TableSettings} from "../config/keys/table.ts";
import {readPitch} from "../guard/pitch.ts";
import type {ChildOutcome} from "../io/exec.ts";
import type {TimelineFacts} from "../io/issues.ts";
import {typeLabel} from "../triage/facets.ts";
import type {LaneRecord} from "../wire/lane-record.ts";
import {type CheckRow, plainWordsOf} from "./agenda.ts";
import {type HeadRow, weekLanes} from "./flags.ts";
import {type Group, issuesOf} from "./group.ts";
import {isLanded} from "./health.ts";
import {ORIGIN_OPTION} from "./sync.ts";

export const SHIPPED_STAGE = "shipped";

const DAY_MS = 86_400_000;

/** A shipped bet due back at the table. */
export interface DueCheck {
	readonly group: Group;
	readonly shippedAt: string;
}

/** Whether the row is a bet: its Origin says the work was picked at a table. */
export const isBet = (row: Pick<HeadRow, "origin">): boolean => row.origin === ORIGIN_OPTION.bet;

/** Every bet that has read `shipped` for at least `delayDays`, by head. */
export const dueChecks = (
	rows: ReadonlyArray<HeadRow>,
	delayDays: number,
	now: Date,
): ReadonlyArray<DueCheck> =>
	rows
		.flatMap((row): DueCheck[] => {
			const stage = row.stage;
			if (stage?.name !== SHIPPED_STAGE || !isBet(row)) return [];
			const shipped = Date.parse(stage.setAt);
			return shipped + delayDays * DAY_MS <= now.getTime()
				? [{group: row.group, shippedAt: stage.setAt}]
				: [];
		})
		.sort((a, b) => a.group.head - b.group.head);

/** The pull requests the row's lanes name, ascending. */
export const prsOf = (
	group: Group,
	records: ReadonlyMap<number, ReadonlyArray<LaneRecord>>,
): ReadonlyArray<number> =>
	[
		...new Set(
			issuesOf(group).flatMap((issue) => (records.get(issue) ?? []).flatMap((r) => r.prs)),
		),
	].sort((a, b) => a - b);

/** The section a check row sits under: the first agenda section. */
export const checkSection = (settings: TableSettings): string =>
	settings.sections.find((name) => name !== OUTSIDE_THE_BETS) ?? OUTSIDE_THE_BETS;

export interface Mention {
	readonly number: number;
	readonly title: string;
	readonly bug: boolean;
	readonly open: boolean;
}

export interface Revert {
	readonly number: number;
	readonly title: string;
	readonly merged: boolean;
}

/** What GitHub shows happened to the row's work since it shipped. */
export interface Signals {
	readonly prs: ReadonlyArray<number>;
	/** Issues filed since it shipped that mention one of its pull requests. */
	readonly mentions: ReadonlyArray<Mention>;
	/** Pull requests titled as a revert that reference one of its pull requests. */
	readonly reverts: ReadonlyArray<Revert>;
	/** The row's own issues reopened since it shipped. */
	readonly reopened: ReadonlyArray<number>;
	/** Open sub-issues still hanging under the row. */
	readonly followUps: ReadonlyArray<number>;
}

const BUG_LABELS: ReadonlySet<string> = new Set([typeLabel("bug"), "bug"]);
const REVERT_TITLE = /^\s*revert\b/i;

export interface SignalsInput {
	readonly check: DueCheck;
	readonly prs: ReadonlyArray<number>;
	/** The timeline of each pull request in `prs`. */
	readonly prTimelines: ReadonlyMap<number, TimelineFacts>;
	/** The timeline of each issue the row stands for. */
	readonly issueTimelines: ReadonlyMap<number, TimelineFacts>;
	readonly followUps: ReadonlyArray<number>;
}

export const signalsOf = (input: SignalsInput): Signals => {
	const since = Date.parse(input.check.shippedAt);
	const own = new Set(issuesOf(input.check.group));
	const mentions = new Map<number, Mention>();
	const reverts = new Map<number, Revert>();
	for (const pr of input.prs) {
		for (const ref of input.prTimelines.get(pr)?.references ?? []) {
			if (ref.isPullRequest) {
				if (REVERT_TITLE.test(ref.title)) {
					reverts.set(ref.number, {number: ref.number, title: ref.title, merged: ref.merged});
				}
				continue;
			}
			if (own.has(ref.number) || Date.parse(ref.createdAt) < since) continue;
			mentions.set(ref.number, {
				number: ref.number,
				title: ref.title,
				bug: ref.labels.some((label) => BUG_LABELS.has(label)),
				open: ref.open,
			});
		}
	}
	const reopened = [...own].filter((issue) =>
		(input.issueTimelines.get(issue)?.reopenedAt ?? []).some((at) => Date.parse(at) >= since),
	);
	const ascending = <A extends {readonly number: number}>(entries: Iterable<A>) =>
		[...entries].sort((a, b) => a.number - b.number);
	return {
		prs: input.prs,
		mentions: ascending(mentions.values()),
		reverts: ascending(reverts.values()),
		reopened: reopened.sort((a, b) => a - b),
		followUps: [...input.followUps].sort((a, b) => a - b),
	};
};

/** Lanes over one window, as the health numbers count them. */
export interface WindowNumbers {
	readonly lanes: number;
	readonly landed: number;
	/** What the measured lanes spent. */
	readonly spentUsd: number;
	readonly unmeasured: number;
}

/** fabrika's land rate and spend in the delay before the row shipped, and since. */
export interface FabrikaNumbers {
	readonly days: number;
	readonly before: WindowNumbers;
	readonly since: WindowNumbers;
}

const cents = (usd: number): number => Math.round(usd * 100) / 100;

const windowNumbers = (
	records: ReadonlyMap<number, ReadonlyArray<LaneRecord>>,
	start: number,
	end: number,
): WindowNumbers => {
	const lanes = [
		...weekLanes(records, {
			start: new Date(start).toISOString(),
			end: new Date(end).toISOString(),
		}).values(),
	].flat();
	let spentUsd = 0;
	let unmeasured = 0;
	for (const lane of lanes) {
		if (lane.spent._tag === "Measured") spentUsd += lane.spent.usd;
		else unmeasured += 1;
	}
	return {
		lanes: lanes.length,
		landed: lanes.filter(isLanded).length,
		spentUsd: cents(spentUsd),
		unmeasured,
	};
};

/** Whether the issue is fabrika's own work: it carries a `table.fabrikaShare.labels` label. */
export const isFabrikaWork = (labels: ReadonlyArray<string>, settings: TableSettings): boolean =>
	labels.some((label) => settings.fabrikaShare.labels.includes(label));

/** Every lane on the table in the `delayDays` before `shippedAt`, against every lane since. */
export const fabrikaNumbersOf = (
	records: ReadonlyMap<number, ReadonlyArray<LaneRecord>>,
	shippedAt: string,
	delayDays: number,
	now: Date,
): FabrikaNumbers => {
	const shipped = Date.parse(shippedAt);
	return {
		days: delayDays,
		before: windowNumbers(records, shipped - delayDays * DAY_MS, shipped),
		since: windowNumbers(records, shipped, now.getTime() + 1),
	};
};

/** What one evidence source gave. */
export type SourceResult =
	| {
			readonly _tag: "Output";
			readonly name: string;
			readonly text: string;
			readonly truncated: boolean;
	  }
	| {readonly _tag: "Failed"; readonly name: string; readonly reason: string};

/** The bytes of stdout and of stderr prep keeps from one source. */
export const SOURCE_CAPTURE_BYTES = 4000;

const decoded = (bytes: Uint8Array): string => new TextDecoder().decode(bytes).trim();

const firstLine = (text: string): string =>
	text
		.split("\n")
		.find((line) => line.trim() !== "")
		?.trim() ?? "";

export const sourceResultOf = (source: EvidenceSource, outcome: ChildOutcome): SourceResult => {
	const {name} = source;
	if (outcome._tag === "Unstartable") {
		return {_tag: "Failed", name, reason: `could not start: ${outcome.reason}`};
	}
	if (outcome.timedOut) {
		return {_tag: "Failed", name, reason: `timed out after ${source.timeoutSeconds}s`};
	}
	if (outcome.exitCode !== 0) {
		const said = firstLine(decoded(outcome.stderr));
		return {
			_tag: "Failed",
			name,
			reason: `exited ${outcome.exitCode}${said === "" ? "" : `: ${said}`}`,
		};
	}
	return {_tag: "Output", name, text: decoded(outcome.stdout), truncated: outcome.truncated};
};

/** The environment variables a source is told which check it is running for. */
export const sourceEnv = (
	repo: string,
	check: DueCheck,
	prs: ReadonlyArray<number>,
): Readonly<Record<string, string>> => ({
	FABRIKA_CHECK_REPO: repo,
	FABRIKA_CHECK_ISSUE: String(check.group.head),
	FABRIKA_CHECK_PRS: prs.join(" "),
	FABRIKA_CHECK_SHIPPED_AT: check.shippedAt,
});

/** Everything one check carries. */
export interface Evidence {
	readonly issue: number;
	readonly shippedAt: string;
	/** The pitch's `**Success:**` line, or `null` when the issue names none. */
	readonly success: string | null;
	readonly signals: Signals;
	/** `null` when the issue is not fabrika's own work. */
	readonly fabrika: FabrikaNumbers | null;
	readonly sources: ReadonlyArray<SourceResult>;
}

export const successOf = (body: string): string | null => {
	const pitch = readPitch(body);
	return pitch._tag === "present" ? pitch.success : null;
};

/** The line that marks an issue's check comment, so a re-run never posts a second one. */
export const checkMarker = (issue: number): string =>
	`<!-- fabrika:outcome-check issue=${issue} -->`;

export const hasCheckComment = (bodies: ReadonlyArray<string>, issue: number): boolean =>
	bodies.some((body) => body.includes(checkMarker(issue)));

const plural = (count: number, one: string, many = `${one}s`): string =>
	`${count} ${count === 1 ? one : many}`;

const refs = (numbers: ReadonlyArray<number>): string =>
	numbers.map((number) => `#${number}`).join(", ");

const percent = (part: number, whole: number): number => Math.round((part / whole) * 100);

const landRate = (window: WindowNumbers): string =>
	window.lanes === 0
		? "no lane ended"
		: `${percent(window.landed, window.lanes)}% (${window.landed} of ${plural(window.lanes, "lane")})`;

const perLane = (window: WindowNumbers): number | null =>
	window.lanes === 0 || window.unmeasured > 0 ? null : cents(window.spentUsd / window.lanes);

const spendLine = (window: WindowNumbers): string => {
	if (window.lanes === 0) return "no lane ended";
	const each = perLane(window);
	return each === null
		? `$${window.spentUsd} measured, ${plural(window.unmeasured, "lane")} not measured`
		: `$${each} a lane ($${window.spentUsd} over ${plural(window.lanes, "lane")})`;
};

const delta = (before: number | null, since: number | null, unit: "points" | "usd"): string => {
	if (before === null || since === null) return "";
	const change = cents(since - before);
	if (change === 0) return ", no change";
	const size = Math.abs(change);
	const amount = unit === "points" ? `${size} points` : `$${size}`;
	return `, ${change > 0 ? "up" : "down"} ${amount}`;
};

const rateOf = (window: WindowNumbers): number | null =>
	window.lanes === 0 ? null : percent(window.landed, window.lanes);

const fabrikaLines = (numbers: FabrikaNumbers): ReadonlyArray<string> => [
	"### fabrika's numbers",
	"",
	`- Land rate: ${landRate(numbers.before)} in the ${numbers.days} days before it shipped, ${landRate(numbers.since)} since${delta(rateOf(numbers.before), rateOf(numbers.since), "points")}.`,
	`- Spend: ${spendLine(numbers.before)} before, ${spendLine(numbers.since)} since${delta(perLane(numbers.before), perLane(numbers.since), "usd")}.`,
];

/** A fence longer than any backtick run in `text`, so the output cannot close it early. */
const fenceFor = (text: string): string => {
	const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
	return "`".repeat(longest + 1);
};

const sourceLines = (result: SourceResult): ReadonlyArray<string> => {
	if (result._tag === "Failed") return [`**${result.name}**: failed, ${result.reason}.`, ""];
	if (result.text === "") return [`**${result.name}**: printed nothing.`, ""];
	const fence = fenceFor(result.text);
	return [
		`**${result.name}**${result.truncated ? ` (cut at ${SOURCE_CAPTURE_BYTES} bytes)` : ""}:`,
		"",
		fence,
		result.text,
		fence,
		"",
	];
};

const signalLines = (signals: Signals): ReadonlyArray<string> => {
	const mention = (one: Mention) =>
		`#${one.number} ${one.title}${one.bug ? " (bug)" : ""}${one.open ? "" : " (closed)"}`;
	return [
		"### What happened on GitHub since",
		"",
		signals.prs.length === 0
			? "- Pull requests: its lane records name none, so no mention or revert could be read off one."
			: `- Pull requests: ${refs(signals.prs)}.`,
		signals.mentions.length === 0
			? "- New issues mentioning them: none."
			: `- New issues mentioning them: ${signals.mentions.map(mention).join("; ")}.`,
		signals.reverts.length === 0
			? "- Reverts: none."
			: `- Reverts: ${signals.reverts.map((one) => `#${one.number} ${one.title}${one.merged ? " (merged)" : " (not merged)"}`).join("; ")}.`,
		signals.reopened.length === 0 ? "- Reopened: none." : `- Reopened: ${refs(signals.reopened)}.`,
		signals.followUps.length === 0
			? "- Open follow-ups: none."
			: `- Open follow-ups: ${refs(signals.followUps)}.`,
	];
};

/** The comment posted on the issue: the whole evidence, and the one question it asks. */
export const renderCheck = (evidence: Evidence): string => {
	const day = evidence.shippedAt.slice(0, 10);
	return [
		`**Check: did #${evidence.issue} work?** It shipped on ${day}. Answer on its table row by setting Outcome to worked, didn't or can't tell.`,
		"",
		evidence.success === null
			? "**Success:** none. Its pitch names no Success line, so judge it on the evidence below."
			: `**Success:** ${evidence.success}`,
		"",
		...signalLines(evidence.signals),
		...(evidence.fabrika === null ? [] : ["", ...fabrikaLines(evidence.fabrika)]),
		...(evidence.sources.length === 0
			? []
			: ["", "### Evidence sources", "", ...evidence.sources.flatMap(sourceLines)]),
		"",
		checkMarker(evidence.issue),
	]
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
};

const SUCCESS_IN_REC = 120;

const clipped = (text: string, most: number): string =>
	text.length <= most ? text : `${text.slice(0, most - 1).trimEnd()}…`;

/** The Rec a check row reads: the question, the Success line, and the signals as counts. */
export const checkRec = (evidence: Evidence): string => {
	const {signals} = evidence;
	const bugs = signals.mentions.filter((one) => one.bug).length;
	const counts = [
		`${plural(signals.mentions.length, "new issue")}${bugs > 0 ? ` (${bugs} bug${bugs === 1 ? "" : "s"})` : ""}`,
		plural(signals.reverts.length, "revert"),
		`${signals.reopened.length} reopened`,
		plural(signals.followUps.length, "open follow-up"),
	].join(", ");
	const success =
		evidence.success === null
			? "No Success line."
			: `Success: ${clipped(evidence.success, SUCCESS_IN_REC)}`;
	return `did it work? Set Outcome. ${success} Since it shipped: ${counts}. Evidence is on #${evidence.issue}.`;
};

/** The cells prep writes on a check row. */
export const checkRowOf = (
	evidence: Evidence,
	issue: {readonly title: string; readonly body: string},
	settings: TableSettings,
): CheckRow => ({
	issue: evidence.issue,
	section: checkSection(settings),
	rec: checkRec(evidence),
	plainWords: plainWordsOf(issue),
});
