/**
 * What `table sync` writes, as data. Pure, so "a second run writes nothing" is a property of
 * {@link planSync} — a project already in step plans no write — rather than of a live run.
 *
 * Two questions, answered in order. {@link scope} decides which issues the run touches and which of
 * them head a group row. {@link planSync} then decides every write against the rows as they read.
 *
 * The rules the plan holds:
 * - **Rows are real issues only.** The one add is an issue by number, so no draft item can be made,
 *   and a closed issue that is not already a row is never added.
 * - **A person's Stage stands.** Sync writes only `in lane` and `shipped`, and only over an unset
 *   Stage or one of those. `bet` and `not now` are a person's answer at the table; `check` belongs
 *   to the outcome check. Sync overwrites none of them.
 * - **Spent $ and Asks start at the bet.** On a row whose Stage is `bet`, only lanes ending at or
 *   after that value's `updatedAt` count, so a new bet starts at 0.
 * - **A group row sums its members, and its members carry no Section**, so they show only in the
 *   members view. A head with no Section, no `bet` and at least one lane lands under Outside the bets.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9856
 */

import {OUTSIDE_THE_BETS} from "../config/keys/table.ts";
import type {FieldValue, ItemFieldValue, ProjectField, ProjectSnapshot} from "../io/projects.ts";
import type {LaneRecord, Origin} from "../wire/lane-record.ts";
import {type Group, groupOf, type IssueNode, issuesOf, membersOf} from "./group.ts";
import {FIELD} from "./shape.ts";
import {addTallies, EMPTY_TALLY, latestRecord, type Tally, tally} from "./tally.ts";

/** A graph node with the edges pointing up from it, which sync walks to find the rows above. */
export interface SyncNode extends IssueNode {
	readonly blocking: ReadonlyArray<number>;
}

export interface Row {
	readonly itemId: string;
	readonly issue: number;
	readonly values: ReadonlyArray<ItemFieldValue>;
}

export type Scope =
	| {readonly _tag: "Incomplete"; readonly missing: ReadonlyArray<number>}
	| {
			readonly _tag: "Scoped";
			/** Every group row the run keeps, by its head. */
			readonly heads: ReadonlyArray<Group>;
			/** Every issue some head stands for. */
			readonly members: ReadonlySet<number>;
	  };

/**
 * The issues a run touches. From each seed it walks up through open issues — to the epic it hangs
 * under, and to what it blocks — so a lane's record reaches the group rows that sum it. A reached
 * issue heads a row when it is a seed, already a row, or an epic something hangs under. An issue
 * another head stands for is a member, never a head.
 */
export const scope = (
	seeds: ReadonlyArray<number>,
	rows: ReadonlySet<number>,
	graph: ReadonlyMap<number, SyncNode>,
): Scope => {
	const missing = new Set<number>();
	const reached = new Set<number>();
	const parents = new Set<number>();
	const queue = [...seeds];
	while (queue.length > 0) {
		const next = queue.shift() as number;
		if (reached.has(next)) continue;
		const node = graph.get(next);
		if (node === undefined) {
			missing.add(next);
			continue;
		}
		reached.add(next);
		if (!node.open) continue;
		if (node.parent !== null) {
			parents.add(node.parent);
			queue.push(node.parent);
		}
		queue.push(...node.blocking);
	}
	if (missing.size > 0) return {_tag: "Incomplete", missing: [...missing].sort((a, b) => a - b)};

	const candidates = [...reached]
		.filter(
			(issue) =>
				seeds.includes(issue) ||
				rows.has(issue) ||
				(parents.has(issue) && graph.get(issue)?.open === true),
		)
		.sort((a, b) => a - b);
	const groups: Group[] = [];
	for (const head of candidates) {
		const membership = groupOf(head, graph);
		if (membership._tag === "Incomplete") {
			for (const issue of membership.missing) missing.add(issue);
			continue;
		}
		groups.push(membership.group);
	}
	if (missing.size > 0) return {_tag: "Incomplete", missing: [...missing].sort((a, b) => a - b)};
	const members = new Set(groups.flatMap(membersOf));
	return {_tag: "Scoped", heads: groups.filter((group) => !members.has(group.head)), members};
};

interface Select {
	readonly id: string;
	readonly options: ReadonlyMap<string, string>;
}

/** The project fields sync writes, resolved to their ids. */
export interface TableFields {
	readonly stage: Select;
	readonly section: Select;
	readonly origin: Select;
	readonly spent: string;
	readonly asks: string;
}

const STAGE = {
	inLane: "in lane",
	shipped: "shipped",
	proposed: "proposed",
	bet: "bet",
} as const;

/** The Stage values sync may replace. Every other value is a person's, or the outcome check's. */
const SYNC_OWNED: ReadonlySet<string> = new Set([STAGE.proposed, STAGE.inLane, STAGE.shipped]);

/** A record's origin, as the Origin field names it. */
export const ORIGIN_OPTION: Readonly<Record<Origin, string>> = {
	bet: "bet",
	"founder-start": "hand-start",
	"driver-pick": "driver pick",
	experiment: "experiment",
	"mid-lane-fix": "found mid-lane",
};

export type Resolved =
	| {readonly _tag: "Resolved"; readonly fields: TableFields}
	| {readonly _tag: "Missing"; readonly what: ReadonlyArray<string>};

/** The fields and options sync writes, or everything the project lacks of them. */
export const tableFields = (project: ProjectSnapshot): Resolved => {
	const lacking: string[] = [];
	const find = (name: string): ProjectField | undefined =>
		project.fields.find((field) => field.name === name);
	const select = (name: string, needs: ReadonlyArray<string>): Select | null => {
		const field = find(name);
		if (field?._tag !== "SingleSelect") {
			lacking.push(`the single-select field ${name}`);
			return null;
		}
		const options = new Map(field.options.map((option) => [option.name, option.id] as const));
		for (const option of needs) {
			if (!options.has(option)) lacking.push(`the ${name} option "${option}"`);
		}
		return {id: field.id, options};
	};
	const number = (name: string): string | null => {
		const field = find(name);
		if (field?._tag !== "Plain" || field.dataType !== "NUMBER") {
			lacking.push(`the number field ${name}`);
			return null;
		}
		return field.id;
	};
	const stage = select(FIELD.stage, [STAGE.inLane, STAGE.shipped]);
	const section = select(FIELD.section, [OUTSIDE_THE_BETS]);
	const origin = select(FIELD.origin, Object.values(ORIGIN_OPTION));
	const spent = number(FIELD.spent);
	const asks = number(FIELD.asks);
	if (stage === null || section === null || origin === null || spent === null || asks === null) {
		return {_tag: "Missing", what: lacking};
	}
	return lacking.length > 0
		? {_tag: "Missing", what: lacking}
		: {_tag: "Resolved", fields: {stage, section, origin, spent, asks}};
};

export type Write =
	| {readonly _tag: "Add"; readonly issue: number}
	| {
			readonly _tag: "Set";
			readonly issue: number;
			readonly itemId: string;
			readonly field: string;
			readonly fieldId: string;
			readonly value: FieldValue;
			/** The value as a person reads it. */
			readonly shown: string;
	  }
	| {
			readonly _tag: "Clear";
			readonly issue: number;
			readonly itemId: string;
			readonly field: string;
			readonly fieldId: string;
	  };

export interface Skip {
	readonly issue: number;
	readonly reason: string;
}

export interface SyncPlan {
	readonly writes: ReadonlyArray<Write>;
	readonly skipped: ReadonlyArray<Skip>;
}

export interface SyncInput {
	readonly scope: Extract<Scope, {_tag: "Scoped"}>;
	readonly rows: ReadonlyMap<number, Row>;
	readonly graph: ReadonlyMap<number, SyncNode>;
	/** Every lane record standing on each touched issue. */
	readonly records: ReadonlyMap<number, ReadonlyArray<LaneRecord>>;
	/** The pull requests, among those the records name, that have merged. */
	readonly merged: ReadonlySet<number>;
	readonly fields: TableFields;
}

const fieldValueOf = (row: Row, field: string): ItemFieldValue | undefined =>
	row.values.find((value) => value.fieldName === field);

const optionName = (row: Row, field: string): string | null => {
	const value = fieldValueOf(row, field)?.value;
	return value?._tag === "Option" ? value.name : null;
};

const numberOf = (row: Row, field: string): number | null => {
	const value = fieldValueOf(row, field)?.value;
	return value?._tag === "Number" ? value.number : null;
};

/** Where a row's count starts: the moment its Stage became `bet`, or every lane when it is not bet. */
const sinceOf = (row: Row): string | null => {
	const stage = fieldValueOf(row, FIELD.stage);
	return stage?.value._tag === "Option" && stage.value.name === STAGE.bet ? stage.updatedAt : null;
};

/**
 * Every lane counted for `issues`, each within `since`. The one sum a group row is judged by: sync
 * writes it and the flags read it, so the two never disagree about what a row spent.
 */
export const tallyOver = (
	issues: ReadonlyArray<number>,
	records: SyncInput["records"],
	since: string | null,
): Tally =>
	issues.map((issue) => tally(records.get(issue) ?? [], since)).reduce(addTallies, EMPTY_TALLY);

/** The Stage the issue's own lanes put it at: shipped once a PR they name merged, else in lane. */
const laneStage = (
	records: ReadonlyArray<LaneRecord>,
	merged: ReadonlySet<number>,
): string | null => {
	if (records.length === 0) return null;
	return records.some((record) => record.prs.some((pr) => merged.has(pr)))
		? STAGE.shipped
		: STAGE.inLane;
};

const planRow = (
	row: Row,
	role: {readonly _tag: "Head"; readonly group: Group} | {readonly _tag: "Member"},
	input: SyncInput,
): ReadonlyArray<Write> => {
	const {fields, records} = input;
	const writes: Write[] = [];
	const own = records.get(row.issue) ?? [];
	const set = (field: string, fieldId: string, value: FieldValue, shown: string) =>
		writes.push({_tag: "Set", issue: row.issue, itemId: row.itemId, field, fieldId, value, shown});

	const currentStage = optionName(row, FIELD.stage);
	const wantedStage = laneStage(own, input.merged);
	let stage = currentStage;
	if (
		wantedStage !== null &&
		wantedStage !== currentStage &&
		(currentStage === null || SYNC_OWNED.has(currentStage))
	) {
		const optionId = fields.stage.options.get(wantedStage) as string;
		set(FIELD.stage, fields.stage.id, {_tag: "Option", optionId}, wantedStage);
		stage = wantedStage;
	}

	const since = sinceOf(row);
	const issues = role._tag === "Head" ? issuesOf(role.group) : [row.issue];
	const counted = tallyOver(issues, records, since);
	const isBet = since !== null;

	const section = optionName(row, FIELD.section);
	if (role._tag === "Member" && section !== null) {
		writes.push({
			_tag: "Clear",
			issue: row.issue,
			itemId: row.itemId,
			field: FIELD.section,
			fieldId: fields.section.id,
		});
	}
	if (
		role._tag === "Head" &&
		section === null &&
		counted.lanes > 0 &&
		(stage === null || SYNC_OWNED.has(stage))
	) {
		const optionId = fields.section.options.get(OUTSIDE_THE_BETS) as string;
		set(FIELD.section, fields.section.id, {_tag: "Option", optionId}, OUTSIDE_THE_BETS);
	}

	if (isBet || counted.lanes > 0) {
		if (counted.spend._tag === "Measured" && numberOf(row, FIELD.spent) !== counted.spend.usd) {
			set(
				FIELD.spent,
				fields.spent,
				{_tag: "Number", number: counted.spend.usd},
				`$${counted.spend.usd}`,
			);
		}
		if (numberOf(row, FIELD.asks) !== counted.asks) {
			set(FIELD.asks, fields.asks, {_tag: "Number", number: counted.asks}, String(counted.asks));
		}
	}

	const latest = latestRecord(own);
	if (latest !== null) {
		const wanted = ORIGIN_OPTION[latest.origin];
		if (optionName(row, FIELD.origin) !== wanted) {
			const optionId = fields.origin.options.get(wanted) as string;
			set(FIELD.origin, fields.origin.id, {_tag: "Option", optionId}, wanted);
		}
	}
	return writes;
};

/**
 * Every write that brings the touched rows in step with their records and groups. Issues that are
 * not rows yet plan an `Add` and nothing else: their values are planned once the add has landed and
 * the item has an id.
 */
export const planSync = (input: SyncInput): SyncPlan => {
	const writes: Write[] = [];
	const skipped: Skip[] = [];
	const touch = (issue: number, role: Parameters<typeof planRow>[1]) => {
		const row = input.rows.get(issue);
		if (row !== undefined) {
			writes.push(...planRow(row, role, input));
			return;
		}
		if (input.graph.get(issue)?.open === true) writes.push({_tag: "Add", issue});
		else skipped.push({issue, reason: "closed and not on the table, so it is not added"});
	};
	for (const group of input.scope.heads) touch(group.head, {_tag: "Head", group});
	for (const member of [...input.scope.members].sort((a, b) => a - b)) {
		touch(member, {_tag: "Member"});
	}
	return {writes, skipped};
};

export const describeWrite = (write: Write): string => {
	switch (write._tag) {
		case "Add":
			return `added #${write.issue} to the table`;
		case "Set":
			return `set #${write.issue} ${write.field} to ${write.shown}`;
		case "Clear":
			return `cleared #${write.issue} ${write.field}`;
	}
};
