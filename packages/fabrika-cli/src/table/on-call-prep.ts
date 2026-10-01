/**
 * What `table route`, `table prep` and `table flags` do with the on-call board a `boards` block adds:
 * read it, route the open issues onto it, and plan the writes that put each routed issue there with
 * its target.
 *
 * **A person's answer at the table keeps an issue on the table.** An issue whose table row reads
 * `bet`, `not now` or `check` stays on the product board whatever the routing rule says, and so do
 * the members of a group whose head reads one, so a split never pulls decided work out from under
 * the table. Every other open issue the rule routes to on-call goes there and leaves the table:
 * the agenda does not propose it, and route takes its table row off once it has placed it.
 *
 * **The Response target cell is a projection, never a source.** The target an item waits against is
 * the one its labels pick now, and the wait runs from the issue's filing, so a relabel moves the
 * target and no run's timing moves the clock. Route rewrites the cell to match; flags never read it.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9914
 * @ruling https://github.com/kamp-us/phoenix/issues/10302
 */

import {Effect} from "effect";
import type {Boards, OnCallBoard} from "../config/keys/boards.ts";
import type {ListedIssue} from "../io/issues.ts";
import type {FieldValue, ProjectField, ProjectSnapshot} from "../io/projects.ts";
import {isCustomer, optionOf, type PrepWrite, plainWordsOf, textOf} from "./agenda.ts";
import {BET_STAGE} from "./bets.ts";
import type {DueCheck} from "./check.ts";
import type {HeadRow, OnCallItem} from "./flags.ts";
import {stopOn} from "./flags-read.ts";
import {issuesOf} from "./group.ts";
import {boardOf, ON_CALL_FIELD, onCallBoard, responseTargetOf} from "./on-call.ts";
import {FIELD} from "./shape.ts";
import type {Row} from "./sync.ts";
import {type Refusal, rowsOf, type TableBoard} from "./sync-verb.ts";

/** Table Stages that are a person's answer, or a check: an issue holding one stays on the table. */
const HELD: ReadonlySet<string> = new Set([BET_STAGE, "not now", "check"]);

/**
 * Every Origin an issue is known by: its table row's, and `customer` when its filer only uses the
 * product. The row's Origin names the latest lane, so it adds to the filer's and never replaces it.
 */
export const originsFor = (issue: ListedIssue, row: Row | undefined): ReadonlyArray<string> => {
	const origins: string[] = [];
	const onRow = optionOf(row, FIELD.origin);
	if (onRow !== null) origins.push(onRow);
	if (isCustomer(issue) && !origins.includes("customer")) origins.push("customer");
	return origins;
};

/**
 * Every issue a person's answer holds on the table: a row reading a held Stage, and every issue its
 * group stands for, since a bet on a chain or an epic bets on its members too. A shipped bet due its
 * outcome check holds the same way, since the same prep run turns it into a check row.
 */
export const heldOf = (
	table: ReadonlyMap<number, Row>,
	heads: ReadonlyArray<Pick<HeadRow, "group" | "stage">>,
	due: ReadonlyArray<Pick<DueCheck, "group">>,
): ReadonlySet<number> => {
	const held = new Set<number>();
	for (const check of due) for (const issue of issuesOf(check.group)) held.add(issue);
	for (const row of table.values()) {
		const stage = optionOf(row, FIELD.stage);
		if (stage !== null && HELD.has(stage)) held.add(row.issue);
	}
	for (const head of heads) {
		if (head.stage !== null && HELD.has(head.stage.name)) {
			for (const issue of issuesOf(head.group)) held.add(issue);
		}
	}
	return held;
};

/**
 * The open issues the on-call board holds, in the order they arrived: every one `settings.route`
 * sends there, except those the table already answered, directly or through the group they are in,
 * and those `due` brings back as checks.
 */
export const onCallIssuesOf = (
	open: ReadonlyMap<number, ListedIssue>,
	table: ReadonlyMap<number, Row>,
	heads: ReadonlyArray<Pick<HeadRow, "group" | "stage">>,
	settings: OnCallBoard,
	due: ReadonlyArray<Pick<DueCheck, "group">>,
): ReadonlyArray<ListedIssue> => {
	const held = heldOf(table, heads, due);
	return [...open.values()]
		.filter(
			(issue) =>
				!held.has(issue.number) &&
				boardOf(
					{origins: originsFor(issue, table.get(issue.number)), labels: issue.labels},
					settings.route,
				) === "on-call",
		)
		.sort((a, b) => a.number - b.number);
};

interface Select {
	readonly id: string;
	readonly options: ReadonlyMap<string, string>;
}

/** The on-call fields route writes, resolved to their ids. */
export interface OnCallFields {
	readonly responseTarget: Select;
	readonly plainWords: string;
}

export type OnCallResolved =
	| {readonly _tag: "Resolved"; readonly fields: OnCallFields}
	| {readonly _tag: "Missing"; readonly what: ReadonlyArray<string>};

export const onCallFields = (project: ProjectSnapshot, settings: OnCallBoard): OnCallResolved => {
	const find = (name: string): ProjectField | undefined =>
		project.fields.find((field) => field.name === name);
	const lacking: string[] = [];
	const target = find(ON_CALL_FIELD.responseTarget);
	const options =
		target?._tag === "SingleSelect"
			? new Map(target.options.map((option) => [option.name, option.id] as const))
			: null;
	if (target?._tag !== "SingleSelect" || options === null) {
		lacking.push(`the single-select field ${ON_CALL_FIELD.responseTarget}`);
	} else {
		const names = [
			...settings.responseTargets.byLabel.map((one) => one.name),
			settings.responseTargets.otherwise.name,
		];
		for (const name of names) {
			if (!options.has(name)) lacking.push(`the ${ON_CALL_FIELD.responseTarget} option "${name}"`);
		}
	}
	const plain = find(FIELD.plainWords);
	if (plain?._tag !== "Plain" || plain.dataType !== "TEXT") {
		lacking.push(`the text field ${FIELD.plainWords}`);
	}
	if (
		lacking.length > 0 ||
		target?._tag !== "SingleSelect" ||
		options === null ||
		plain?._tag !== "Plain"
	) {
		return {_tag: "Missing", what: lacking};
	}
	return {
		_tag: "Resolved",
		fields: {responseTarget: {id: target.id, options}, plainWords: plain.id},
	};
};

export interface OnCallPlanInput {
	readonly fields: OnCallFields;
	readonly settings: OnCallBoard;
	/** The on-call board's rows as they read. */
	readonly rows: ReadonlyMap<number, Row>;
	/** The issues to place, in arrival order. */
	readonly issues: ReadonlyArray<ListedIssue>;
}

/**
 * Every write that puts the routed issues on the on-call board: an add for an issue with no item,
 * then the Response target its labels pick now and its In plain words line.
 */
export const planOnCall = (input: OnCallPlanInput): ReadonlyArray<PrepWrite> => {
	const {fields, rows} = input;
	const writes: PrepWrite[] = [];
	for (const issue of input.issues) {
		const row = rows.get(issue.number);
		if (row === undefined) {
			writes.push({_tag: "Add", issue: issue.number});
			continue;
		}
		const set = (field: string, fieldId: string, value: FieldValue, shown: string) =>
			writes.push({
				_tag: "Set",
				issue: row.issue,
				itemId: row.itemId,
				field,
				fieldId,
				value,
				shown,
			});
		const target = responseTargetOf(issue.labels, input.settings.responseTargets);
		if (optionOf(row, ON_CALL_FIELD.responseTarget) !== target.name) {
			set(
				ON_CALL_FIELD.responseTarget,
				fields.responseTarget.id,
				{_tag: "Option", optionId: fields.responseTarget.options.get(target.name) as string},
				target.name,
			);
		}
		const words = plainWordsOf(issue);
		if (textOf(row, FIELD.plainWords) !== words) {
			set(FIELD.plainWords, fields.plainWords, {_tag: "Text", text: words}, `"${words}"`);
		}
	}
	return writes;
};

/**
 * The open on-call items as the flags judge them: every open issue on the board, and every one in
 * `routed` that route has yet to place, each read off the issue itself.
 */
export const onCallItemsOf = (
	rows: ReadonlyMap<number, Row>,
	open: ReadonlyMap<number, ListedIssue>,
	routed: ReadonlyArray<ListedIssue>,
): ReadonlyArray<OnCallItem> => {
	const items = new Map<number, OnCallItem>();
	const item = (issue: ListedIssue) =>
		items.set(issue.number, {
			issue: issue.number,
			labels: issue.labels,
			createdAt: issue.createdAt,
		});
	for (const row of rows.values()) {
		const issue = open.get(row.issue);
		if (issue !== undefined) item(issue);
	}
	for (const issue of routed) item(issue);
	return [...items.values()].sort((a, b) => a.issue - b.issue);
};

/** The on-call board, read; `One` when no `boards` block splits the work. */
export type OnCallBoardRead =
	| {readonly _tag: "One"}
	| {
			readonly _tag: "Split";
			readonly settings: OnCallBoard;
			readonly project: ProjectSnapshot;
			readonly rows: ReadonlyMap<number, Row>;
	  };

export const readOnCall = <R>(
	board: TableBoard<R>,
	verb: string,
	repo: string,
	boards: Boards,
): Effect.Effect<OnCallBoardRead | Refusal, never, R> =>
	Effect.gen(function* () {
		if (boards._tag === "One") return {_tag: "One"} as const;
		const settings = boards.onCall;
		const located = yield* board.locate(repo, onCallBoard(repo, settings));
		if (located._tag !== "Ok") return stopOn(verb, located, "cannot find the on-call board");
		if (located.value._tag === "Refused") {
			return {
				...located.value,
				reason: located.value.reason.replace(`${verb}: `, `${verb}: the on-call board: `),
			};
		}
		const {project} = located.value;
		const items = yield* board.items(project.id);
		if (items._tag !== "Ok") {
			return stopOn(verb, items, `cannot read the on-call board #${project.number}'s items`);
		}
		return {_tag: "Split", settings, project, rows: rowsOf(items.value, repo)};
	});
