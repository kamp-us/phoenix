/**
 * The digest: which open issues have waited past a response target, and the message that says so.
 *
 * Pure: it reads the open issues, the on-call board as read and the config, and writes nothing, so
 * what a scheduled run posts is a property of this module. `digest-post.ts` sends the message;
 * `digest-verb.ts` joins the two.
 *
 * **The on-call section is `table flags`'s `past-target` list.** It judges the open items on the
 * on-call board through {@link pastTargetOf}, with the wait starting at the issue's filing or at the
 * board's making when that is later, so the channel and the table never name different items.
 *
 * **One message, both tools.** The text is cut to {@link MESSAGE_LIMIT}, the tighter of the two
 * tools' documented limits, and the cut says how many lines it dropped.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10357
 * @ruling https://github.com/kamp-us/phoenix/issues/10302
 */

import type {ResponseTargets} from "../config/keys/boards.ts";
import type {ChatTool, DigestSection, DigestSettings} from "../config/keys/digest.ts";
import type {ListedIssue} from "../io/issues.ts";
import {NEEDS_TRIAGE} from "../labels.ts";
import {type OnCallItem, pastTargetOf} from "./flags.ts";

const HOUR_MS = 3_600_000;

/** Discord's documented cap on a webhook message's `content`. */
export const MESSAGE_LIMIT = 2000;

const TITLE_LIMIT = 80;

/** An open issue that has waited longer than its target allows. */
export interface Late {
	readonly issue: number;
	readonly title: string;
	/** The target as the message names it: the on-call target's name, or the triage target's hours. */
	readonly target: string;
	readonly hours: number;
	/** When the wait started. */
	readonly since: string;
	readonly waitedHours: number;
}

export interface SectionReport {
	readonly section: DigestSection;
	/** Oldest wait first. */
	readonly late: ReadonlyArray<Late>;
}

export interface DigestReport {
	readonly sections: ReadonlyArray<SectionReport>;
	/** Sections the block asks for that this repository has nothing to measure against. */
	readonly notAsked: ReadonlyArray<DigestSection>;
}

/** The on-call board's open items and what they are judged against. */
export interface OnCallQueue {
	readonly targets: ResponseTargets;
	/** When the on-call board was made: no item's wait starts before it. */
	readonly boardCreatedAt: string;
	readonly open: ReadonlyArray<OnCallItem>;
}

export interface DigestInput {
	readonly now: Date;
	readonly open: ReadonlyArray<ListedIssue>;
	readonly settings: Pick<DigestSettings, "sections" | "triageTargetHours">;
	/** The on-call board as read, or `null` when no `boards` block splits the work. */
	readonly onCall: OnCallQueue | null;
}

const hoursWords = (hours: number): string => `${hours} hour${hours === 1 ? "" : "s"}`;

const oldestFirst = (a: Late, b: Late): number =>
	Date.parse(a.since) - Date.parse(b.since) || a.issue - b.issue;

const untriaged = (issue: ListedIssue): boolean =>
	issue.labels.length === 0 || issue.labels.includes(NEEDS_TRIAGE);

const triageLate = (input: DigestInput): ReadonlyArray<Late> => {
	const hours = input.settings.triageTargetHours;
	return input.open
		.filter(untriaged)
		.flatMap((issue): ReadonlyArray<Late> => {
			const waited = (input.now.getTime() - Date.parse(issue.createdAt)) / HOUR_MS;
			return waited > hours
				? [
						{
							issue: issue.number,
							title: issue.title,
							target: hoursWords(hours),
							hours,
							since: issue.createdAt,
							waitedHours: Math.floor(waited),
						},
					]
				: [];
		})
		.sort(oldestFirst);
};

const onCallLate = (input: DigestInput, queue: OnCallQueue): ReadonlyArray<Late> => {
	const titles = new Map(input.open.map((issue) => [issue.number, issue.title] as const));
	return queue.open
		.flatMap((item): ReadonlyArray<Late> => {
			const past = pastTargetOf(item, queue.targets, queue.boardCreatedAt, input.now);
			if (past === null) return [];
			const {_tag, ...fields} = past;
			return [{...fields, title: titles.get(item.issue) ?? ""}];
		})
		.sort(oldestFirst);
};

export const digestOf = (input: DigestInput): DigestReport => {
	const sections: SectionReport[] = [];
	const notAsked: DigestSection[] = [];
	for (const section of input.settings.sections) {
		if (section === "triage") sections.push({section, late: triageLate(input)});
		else if (input.onCall === null) notAsked.push(section);
		else sections.push({section, late: onCallLate(input, input.onCall)});
	}
	return {sections, notAsked};
};

export const lateCount = (report: DigestReport): number =>
	report.sections.reduce((sum, section) => sum + section.late.length, 0);

const waitWords = (hours: number): string =>
	hours < 48 ? hoursWords(hours) : `${Math.floor(hours / 24)} days`;

const HEADING: Readonly<Record<DigestSection, string>> = {
	triage: "Waiting for triage",
	"on-call": "On-call, past target",
};

const clip = (title: string): string => {
	const flat = title.replace(/\s+/g, " ").trim();
	return flat.length > TITLE_LIMIT ? `${flat.slice(0, TITLE_LIMIT - 1)}…` : flat;
};

/** Slack reads `&`, `<` and `>` as control characters; escaped, a title can start no link or mention. */
const slackEscape = (text: string): string =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export interface Where {
	readonly repo: string;
	/** The GitHub host's base URL, without a trailing slash. */
	readonly serverUrl: string;
	readonly tool: ChatTool;
}

/**
 * The message for `report`, at most {@link MESSAGE_LIMIT} characters. Each line names the issue,
 * its target and how long it has waited. Lines that do not fit are dropped from the end and counted.
 */
export const renderDigest = (report: DigestReport, where: Where): string => {
	const escaped = where.tool === "slack" ? slackEscape : (text: string): string => text;
	const total = lateCount(report);
	if (total === 0) return escaped(`${where.repo}: nothing is past its response target.`);
	const head = escaped(
		`${where.repo}: ${total} issue${total === 1 ? "" : "s"} past ${total === 1 ? "its" : "their"} response target`,
	);
	const dropped = (count: number): string => `…and ${count} more not shown.`;
	const reserve = dropped(total).length + 1;
	const lines = [head];
	let size = head.length;
	let shown = 0;
	fill: for (const section of report.sections) {
		if (section.late.length === 0) continue;
		const heading = `${HEADING[section.section]} (${section.late.length}):`;
		let headed = false;
		for (const late of section.late) {
			const line = `- ${escaped(`#${late.issue} ${clip(late.title)}: target ${late.target}, waited ${waitWords(late.waitedHours)}.`)} ${where.serverUrl}/${where.repo}/issues/${late.issue}`;
			const cost = line.length + 1 + (headed ? 0 : heading.length + 1);
			if (size + cost + reserve > MESSAGE_LIMIT) break fill;
			if (!headed) lines.push(heading);
			headed = true;
			lines.push(line);
			size += cost;
			shown += 1;
		}
	}
	if (shown < total) lines.push(dropped(total - shown));
	return lines.join("\n");
};

/** Discord's `SUPPRESS_EMBEDS` message flag: a list of issue links unfurls into no previews. */
const SUPPRESS_EMBEDS = 1 << 2;

/**
 * The JSON body each tool's webhook accepts. Slack takes `text`. Discord takes `content`, with
 * `allowed_mentions` parsing nothing so an issue title can ping nobody.
 */
export const payloadOf = (tool: ChatTool, text: string): Readonly<Record<string, unknown>> =>
	tool === "slack"
		? {text}
		: {content: text, allowed_mentions: {parse: []}, flags: SUPPRESS_EMBEDS};
