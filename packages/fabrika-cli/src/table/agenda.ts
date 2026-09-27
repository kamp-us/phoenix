/**
 * What `table prep` puts on the next table's agenda, as data. Pure, so "a second run adds nothing"
 * is a property of {@link planPrep} over rows already in step, not of a live run.
 *
 * Three steps, in order. {@link candidatesOf} sorts the open board into the agenda sections and
 * names the Customers reports that must be triaged first. {@link admit} takes the candidates one at
 * a time with the group each heads, and keeps a row count under the cap. {@link planPrep} then
 * decides every write against the rows as they read.
 *
 * The rules it holds:
 * - **A row is a real, open issue.** The only add is an issue by number, so no draft can be made;
 *   only open issues are candidates; and a `proposed` row whose issue closed is taken off the table.
 * - **A row and its open blockers are one chain row.** Its group comes from {@link groupOf}, so it
 *   counts once toward the cap, its members carry no Section and show only in the members view, and
 *   no candidate is left off because it has blockers. A candidate a chosen row already covers is
 *   not proposed again, and a chosen row a later chain covers moves inside that chain.
 * - **A person's answer stands.** A row already `bet`, `not now`, in a lane, shipped or up for its
 *   check is never re-proposed. The one exception is a running bet with a flag: it comes back to
 *   Tails with the flag's rec, its Stage and Size untouched.
 * - **A ruling is asked for as a pick.** A row whose issue waits on a person (`ready-for:human`)
 *   reads "needs your pick" with its options, never "yes".
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

import type {AppetiteSizes, Size} from "../config/keys/appetite-sizes.ts";
import {OUTSIDE_THE_BETS, type TableSettings} from "../config/keys/table.ts";
import {readPitch} from "../guard/pitch.ts";
import type {ListedIssue} from "../io/issues.ts";
import type {FieldValue, ItemFieldValue} from "../io/projects.ts";
import {NEEDS_INFO, NEEDS_TRIAGE} from "../labels.ts";
import {EPIC_TYPE_LABEL, PRIORITIES} from "../triage/facets.ts";
import {readPlainSummary} from "../triage/plain-summary.ts";
import {BET_STAGE} from "./bets.ts";
import {type Flag, recOf} from "./flags.ts";
import {type Group, issuesOf, membersOf} from "./group.ts";
import {FIELD} from "./shape.ts";
import type {Row, Write} from "./sync.ts";

export const PROPOSED = "proposed";
export const READY_FOR_HUMAN = "ready-for:human";

export const TAILS = "Tails";
export const CUSTOMERS = "Customers";
export const NEW_BETS = "New bets";

/** Stages that are an answer already given: none of these rows is proposed again. */
const ANSWERED: ReadonlySet<string> = new Set([
	BET_STAGE,
	"not now",
	"in lane",
	"shipped",
	"check",
]);

/** Associations of someone who works on the repository rather than only using it. */
const WORKERS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Why an issue is on the agenda. */
export type Reason =
	/** Already on this iteration's agenda from an earlier run; it keeps its place and its cells. */
	| {readonly _tag: "Standing"}
	/** A running bet the flags bring back. */
	| {readonly _tag: "Flagged"; readonly flags: ReadonlyArray<Flag>}
	/** Left open under an epic that has closed. */
	| {readonly _tag: "FollowUp"; readonly epic: number}
	/** Filed by someone who uses the product, and triaged. */
	| {readonly _tag: "Customer"}
	/** An epic with a pitch nobody has bet on. */
	| {readonly _tag: "Pitched"; readonly appetite: string};

export interface Candidate {
	readonly issue: number;
	readonly section: string;
	readonly reason: Reason;
}

/** A Customers report that must be triaged before it can be proposed. */
export interface TriageFirst {
	readonly issue: number;
	/** Triage asked its filer for more and is waiting on the answer (`status:needs-info`). */
	readonly waitingOnFiler: boolean;
}

/** An open sub-issue of an epic, as the follow-up read names it. */
export interface FollowUp {
	readonly issue: number;
	readonly epic: number;
}

export interface CandidateInput {
	readonly settings: TableSettings;
	readonly open: ReadonlyMap<number, ListedIssue>;
	readonly rows: ReadonlyMap<number, Row>;
	/** Open-or-not sub-issues of closed epics; only the open ones become Tails. */
	readonly followUps: ReadonlyArray<FollowUp>;
	/** The row flags on each running bet's head. */
	readonly flagged: ReadonlyMap<number, ReadonlyArray<Flag>>;
	/** The iteration the agenda is prepared for. */
	readonly target: string;
}

const cell = (row: Row | undefined, field: string): ItemFieldValue["value"] | undefined =>
	row?.values.find((value) => value.fieldName === field)?.value;

export const optionOf = (row: Row | undefined, field: string): string | null => {
	const value = cell(row, field);
	return value?._tag === "Option" ? value.name : null;
};

export const textOf = (row: Row | undefined, field: string): string | null => {
	const value = cell(row, field);
	return value?._tag === "Text" && value.text !== "" ? value.text : null;
};

export const weekOf = (row: Row | undefined): string | null => {
	const value = cell(row, FIELD.week);
	return value?._tag === "Iteration" ? value.iterationId : null;
};

/** Whether the row already sits on `target`'s agenda: this week, under an agenda section, with a rec. */
export const onAgenda = (row: Row | undefined, target: string): boolean => {
	const section = optionOf(row, FIELD.section);
	return (
		weekOf(row) === target &&
		section !== null &&
		section !== OUTSIDE_THE_BETS &&
		textOf(row, FIELD.rec) !== null
	);
};

const answered = (row: Row | undefined): boolean => {
	const stage = optionOf(row, FIELD.stage);
	return stage !== null && ANSWERED.has(stage);
};

/** Someone who uses the product rather than works on it. A bot or an unread association is neither. */
export const isCustomer = (issue: ListedIssue): boolean =>
	issue.association !== "" &&
	!WORKERS.has(issue.association) &&
	issue.author !== "" &&
	!issue.author.endsWith("[bot]");

const priorityRank = (issue: ListedIssue | undefined): number => {
	const rank = PRIORITIES.findIndex((label) => issue?.labels.includes(label) === true);
	return rank === -1 ? PRIORITIES.length : rank;
};

const byPriority =
	(open: ReadonlyMap<number, ListedIssue>) =>
	(a: number, b: number): number =>
		priorityRank(open.get(a)) - priorityRank(open.get(b)) || a - b;

/**
 * Every candidate in agenda order — section by section as `sections` lists them, each section
 * sorted p0 first — with rows already on this iteration's agenda ahead of all of them, and the
 * Customers reports that must be triaged first. An issue is a candidate once, in its first section.
 */
export const candidatesOf = (
	input: CandidateInput,
): {
	readonly candidates: ReadonlyArray<Candidate>;
	readonly triageFirst: ReadonlyArray<TriageFirst>;
} => {
	const {open, rows, settings, target} = input;
	const order = byPriority(open);
	const sections = settings.sections.filter((name) => name !== OUTSIDE_THE_BETS);
	const rank = (section: string): number => {
		const index = sections.indexOf(section);
		return index === -1 ? sections.length : index;
	};
	const fresh = (issue: number): boolean => open.has(issue) && !answered(rows.get(issue));

	const standing: Candidate[] = [...rows.values()]
		.filter((row) => open.has(row.issue) && onAgenda(row, target))
		.map((row) => ({
			issue: row.issue,
			section: optionOf(row, FIELD.section) as string,
			reason: {_tag: "Standing"} as const,
		}))
		.sort((a, b) => rank(a.section) - rank(b.section) || a.issue - b.issue);

	const bySection = new Map<string, Candidate[]>();
	const push = (section: string, candidate: Candidate): void => {
		bySection.set(section, [...(bySection.get(section) ?? []), candidate]);
	};

	for (const [head, flags] of [...input.flagged].sort(([a], [b]) => a - b)) {
		if (open.has(head) && optionOf(rows.get(head), FIELD.stage) === BET_STAGE) {
			push(TAILS, {issue: head, section: TAILS, reason: {_tag: "Flagged", flags}});
		}
	}
	const followUps = [...input.followUps]
		.filter((one) => fresh(one.issue))
		.sort((a, b) => order(a.issue, b.issue));
	for (const one of followUps) {
		push(TAILS, {issue: one.issue, section: TAILS, reason: {_tag: "FollowUp", epic: one.epic}});
	}

	const triageFirst: TriageFirst[] = [];
	const customers: number[] = [];
	const pitched: Array<{readonly issue: number; readonly appetite: string}> = [];
	for (const issue of open.values()) {
		if (!fresh(issue.number)) continue;
		if (isCustomer(issue)) {
			if (issue.labels.includes(NEEDS_INFO)) {
				triageFirst.push({issue: issue.number, waitingOnFiler: true});
			} else if (issue.labels.length === 0 || issue.labels.includes(NEEDS_TRIAGE)) {
				triageFirst.push({issue: issue.number, waitingOnFiler: false});
			} else {
				customers.push(issue.number);
			}
			continue;
		}
		if (issue.labels.includes(EPIC_TYPE_LABEL)) {
			const pitch = readPitch(issue.body);
			if (pitch._tag === "present") {
				pitched.push({
					issue: issue.number,
					appetite:
						pitch.appetite._tag === "size"
							? pitch.appetite.size
							: `${pitch.appetite.cycles} cycles`,
				});
			}
		}
	}
	for (const issue of customers.sort(order)) {
		push(CUSTOMERS, {issue, section: CUSTOMERS, reason: {_tag: "Customer"}});
	}
	for (const one of pitched.sort((a, b) => order(a.issue, b.issue))) {
		push(NEW_BETS, {
			issue: one.issue,
			section: NEW_BETS,
			reason: {_tag: "Pitched", appetite: one.appetite},
		});
	}

	const seen = new Set<number>();
	const candidates: Candidate[] = [];
	for (const candidate of [
		...standing,
		...sections.flatMap((section) => bySection.get(section) ?? []),
	]) {
		if (seen.has(candidate.issue)) continue;
		seen.add(candidate.issue);
		candidates.push(candidate);
	}
	return {
		candidates,
		triageFirst: triageFirst.sort((a, b) => order(a.issue, b.issue)),
	};
};

/** One chosen agenda row: the candidate and the group its row stands for. */
export interface Chosen {
	readonly candidate: Candidate;
	readonly group: Group;
}

export interface Selection {
	readonly chosen: ReadonlyArray<Chosen>;
	/** Candidates the cap left out, in the order they were offered. */
	readonly overflow: ReadonlyArray<number>;
}

export const EMPTY_SELECTION: Selection = {chosen: [], overflow: []};

/** Every issue a selection already stands for, heads and members. */
export const coveredBy = (selection: Selection): ReadonlySet<number> =>
	new Set(selection.chosen.flatMap((chosen) => issuesOf(chosen.group)));

/**
 * Offer one candidate with the group it heads. A candidate a chosen row already covers is skipped;
 * a chosen row this group covers moves inside it, freeing its place; and the row is admitted only
 * when the agenda still has room under `cap`.
 */
export const admit = (
	selection: Selection,
	candidate: Candidate,
	group: Group,
	cap: number,
): Selection => {
	if (coveredBy(selection).has(candidate.issue)) return selection;
	const members = new Set(membersOf(group));
	const kept = selection.chosen.filter((chosen) => !members.has(chosen.candidate.issue));
	if (kept.length + 1 > cap) {
		return {...selection, overflow: [...selection.overflow, candidate.issue]};
	}
	return {...selection, chosen: [...kept, {candidate, group}]};
};

/** The cells prep writes on a chosen row. */
export interface RowCells {
	readonly size: Size;
	readonly rec: string;
	readonly plainWords: string;
}

const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The issue's own plain-language summary, else its title: one line either way. */
export const plainWordsOf = (issue: ListedIssue): string => {
	const read = readPlainSummary(issue.body);
	return read._tag === "Found" ? flat(read.value.summary) : flat(issue.title);
};

const OPTIONS_HEADING = /^#{1,6}\s+.*\boptions?\b/i;
const ANY_HEADING = /^#{1,6}\s/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;
const OPTION_LINE =
	/^\s*(?:[-*+]\s+)?[*_]{0,2}\s*option\s+[A-Za-z0-9]+\s*[*_]{0,2}\s*[:.)–—-]\s*(.+)$/i;

const plainOption = (raw: string): string => {
	const text = flat(
		raw.replace(/[*_]{2}/g, "").replace(/^option\s+[A-Za-z0-9]+\s*[:.)–—-]\s*/i, ""),
	);
	const sentence = /^(.+?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text;
	return sentence.replace(/[.!?]+$/, "").trim();
};

/**
 * The options a ruling chooses between, as the issue lists them: the list under an "Options"
 * heading, else every "Option A: …" line. Each is cut to its first sentence. Empty when the body
 * lists none in either shape.
 */
export const optionsOf = (body: string): ReadonlyArray<string> => {
	const lines = body.split(/\r?\n/);
	const at = lines.findIndex((line) => OPTIONS_HEADING.test(line));
	if (at !== -1) {
		const listed: string[] = [];
		for (const line of lines.slice(at + 1)) {
			if (ANY_HEADING.test(line)) break;
			const item = LIST_ITEM.exec(line)?.[1];
			if (item !== undefined) listed.push(plainOption(item));
		}
		const kept = listed.filter((option) => option !== "");
		if (kept.length > 0) return kept;
	}
	return lines
		.map((line) => OPTION_LINE.exec(line)?.[1])
		.filter((option): option is string => option !== undefined)
		.map(plainOption)
		.filter((option) => option !== "");
};

/** The Rec a ruling row reads: "needs your pick" and its options, never a plain yes. */
export const pickRec = (issue: ListedIssue, head: number): string => {
	const on = issue.number === head ? "" : ` on #${issue.number}`;
	const options = optionsOf(issue.body);
	return options.length === 0
		? `needs your pick${on}: the issue lists no options prep can read, so open it to choose.`
		: `needs your pick${on}: ${options.join(", or ")}.`;
};

/** What one issue is sized at on its own: an epic is L, a pitch its appetite size, anything else S. */
const issueSize = (issue: ListedIssue | undefined): Size => {
	if (issue === undefined) return "S";
	if (issue.labels.includes(EPIC_TYPE_LABEL)) return "L";
	const pitch = readPitch(issue.body);
	if (pitch._tag === "present" && pitch.appetite._tag === "size") return pitch.appetite.size;
	return "S";
};

/**
 * The row's size over the whole group: an epic row is L; any other row is the smallest size whose
 * dollars cover what its issues add up to, and L when nothing smaller does.
 */
export const sizeOfGroup = (
	group: Group,
	open: ReadonlyMap<number, ListedIssue>,
	sizes: AppetiteSizes,
): {readonly size: Size; readonly usd: number} => {
	const usd = issuesOf(group).reduce((sum, issue) => sum + sizes[issueSize(open.get(issue))], 0);
	if (group._tag === "Epic") return {size: "L", usd};
	const size: Size = usd <= sizes.S ? "S" : usd <= sizes.M ? "M" : "L";
	return {size, usd};
};

const numbers = (issues: ReadonlyArray<number>): string => {
	const named = issues.map((issue) => `#${issue}`);
	return named.length <= 1
		? (named[0] ?? "")
		: `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
};

const baseRec = (reason: Reason, settings: TableSettings): string => {
	switch (reason._tag) {
		case "Flagged":
			return reason.flags.map((flag) => recOf(flag, settings)).join(" ");
		case "FollowUp":
			return `yes: finish what #${reason.epic} left open.`;
		case "Customer":
			return "yes: someone using the product reported it.";
		case "Pitched":
			return `yes: pitched at ${reason.appetite}.`;
		case "Standing":
			return "yes.";
	}
};

/**
 * The Size, Rec and In plain words line for one chosen row, each covering the whole group. A chain
 * row names what it needs first; a row where any issue waits on a person reads as a pick.
 */
export const cellsOf = (
	chosen: Chosen,
	open: ReadonlyMap<number, ListedIssue>,
	settings: TableSettings,
	sizes: AppetiteSizes,
): RowCells => {
	const {candidate, group} = chosen;
	const head = open.get(candidate.issue);
	const members = membersOf(group);
	const {size, usd} = sizeOfGroup(group, open, sizes);
	const headWords = head === undefined ? `#${candidate.issue}` : plainWordsOf(head);
	const plainWords =
		group._tag === "Chain"
			? `${/[.!?]$/.test(headWords) ? headWords : `${headWords}.`} It needs ${numbers(members)} done first.`
			: headWords;

	const ruling = issuesOf(group)
		.map((issue) => open.get(issue))
		.find((issue) => issue?.labels.includes(READY_FOR_HUMAN) === true);
	if (ruling !== undefined) return {size, plainWords, rec: pickRec(ruling, candidate.issue)};

	const whole =
		group._tag === "Chain"
			? ` Betting on it bets on ${numbers(members)} too, about $${usd} in all.`
			: group._tag === "Epic" && members.length > 0
				? ` Covers ${members.length} open child issue${members.length === 1 ? "" : "s"}.`
				: "";
	return {size, plainWords, rec: `${baseRec(candidate.reason, settings)}${whole}`};
};

interface Select {
	readonly id: string;
	readonly options: ReadonlyMap<string, string>;
}

/** The project fields prep writes, resolved to their ids. */
export interface PrepFields {
	readonly stage: Select;
	readonly section: Select;
	readonly size: Select;
	readonly rec: string;
	readonly plainWords: string;
	readonly week: string;
}

/** One row prep writes onto the agenda. `cells` is `null` for a standing row, left as it reads. */
export interface AgendaRow {
	readonly issue: number;
	readonly section: string;
	readonly group: Group;
	readonly flaggedBet: boolean;
	readonly cells: RowCells | null;
}

export type PrepWrite =
	| Write
	| {readonly _tag: "Delete"; readonly issue: number; readonly itemId: string};

export interface PrepInput {
	readonly fields: PrepFields;
	readonly target: {readonly id: string; readonly title: string};
	readonly rows: ReadonlyMap<number, Row>;
	readonly open: ReadonlySet<number>;
	readonly agenda: ReadonlyArray<AgendaRow>;
	/** Running bets carried into the target iteration without an agenda row. */
	readonly rollover: ReadonlyArray<number>;
	/** `proposed` rows whose issue has closed. */
	readonly removals: ReadonlyArray<number>;
}

/**
 * Every write that puts the agenda, the rollover and the removals in step with the rows. An issue
 * that is not a row yet plans an `Add` and nothing else; its cells follow once it has an item id.
 */
export const planPrep = (input: PrepInput): ReadonlyArray<PrepWrite> => {
	const {fields, rows, target} = input;
	const writes: PrepWrite[] = [];
	const added = new Set<number>();
	const add = (issue: number): void => {
		if (added.has(issue) || !input.open.has(issue)) return;
		added.add(issue);
		writes.push({_tag: "Add", issue});
	};
	const setOn = (row: Row, field: string, fieldId: string, value: FieldValue, shown: string) =>
		writes.push({_tag: "Set", issue: row.issue, itemId: row.itemId, field, fieldId, value, shown});
	const option = (select: Select, name: string): FieldValue => ({
		_tag: "Option",
		optionId: select.options.get(name) as string,
	});
	const clear = (row: Row, field: string, fieldId: string) =>
		writes.push({_tag: "Clear", issue: row.issue, itemId: row.itemId, field, fieldId});

	for (const entry of input.agenda) {
		const row = rows.get(entry.issue);
		if (row === undefined) {
			add(entry.issue);
		} else if (entry.cells !== null) {
			const {cells} = entry;
			if (!entry.flaggedBet && optionOf(row, FIELD.stage) !== PROPOSED) {
				setOn(row, FIELD.stage, fields.stage.id, option(fields.stage, PROPOSED), PROPOSED);
			}
			if (optionOf(row, FIELD.section) !== entry.section) {
				setOn(
					row,
					FIELD.section,
					fields.section.id,
					option(fields.section, entry.section),
					entry.section,
				);
			}
			if (weekOf(row) !== target.id) {
				setOn(
					row,
					FIELD.week,
					fields.week,
					{_tag: "Iteration", iterationId: target.id},
					target.title,
				);
			}
			if (!entry.flaggedBet && optionOf(row, FIELD.size) === null) {
				setOn(row, FIELD.size, fields.size.id, option(fields.size, cells.size), cells.size);
			}
			if (textOf(row, FIELD.rec) !== cells.rec) {
				setOn(row, FIELD.rec, fields.rec, {_tag: "Text", text: cells.rec}, `"${cells.rec}"`);
			}
			if (textOf(row, FIELD.plainWords) !== cells.plainWords) {
				setOn(
					row,
					FIELD.plainWords,
					fields.plainWords,
					{_tag: "Text", text: cells.plainWords},
					`"${cells.plainWords}"`,
				);
			}
		}
		for (const member of membersOf(entry.group)) {
			const memberRow = rows.get(member);
			if (memberRow === undefined) add(member);
			else if (optionOf(memberRow, FIELD.section) !== null) {
				clear(memberRow, FIELD.section, fields.section.id);
			}
		}
	}

	for (const issue of input.rollover) {
		const row = rows.get(issue);
		if (row === undefined) continue;
		if (weekOf(row) !== target.id) {
			setOn(
				row,
				FIELD.week,
				fields.week,
				{_tag: "Iteration", iterationId: target.id},
				target.title,
			);
		}
		if (textOf(row, FIELD.rec) !== null) clear(row, FIELD.rec, fields.rec);
	}

	for (const issue of input.removals) {
		const row = rows.get(issue);
		if (row !== undefined) writes.push({_tag: "Delete", issue, itemId: row.itemId});
	}
	return writes;
};

export const describePrepWrite = (write: PrepWrite): string => {
	switch (write._tag) {
		case "Add":
			return `added #${write.issue} to the table`;
		case "Set":
			return `set #${write.issue} ${write.field} to ${write.shown}`;
		case "Clear":
			return `cleared #${write.issue} ${write.field}`;
		case "Delete":
			return `took #${write.issue} off the table`;
	}
};

/** The `proposed` rows whose issue has closed: prep takes them off the table. */
export const closedProposals = (
	rows: ReadonlyMap<number, Row>,
	open: ReadonlySet<number>,
): ReadonlyArray<number> =>
	[...rows.values()]
		.filter((row) => !open.has(row.issue) && optionOf(row, FIELD.stage) === PROPOSED)
		.map((row) => row.issue)
		.sort((a, b) => a - b);
