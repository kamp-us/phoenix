/**
 * `table prep` — fill the next table's agenda, carry the running bets into its iteration, and post
 * the week's health as the project's status update.
 *
 * Everything is read before anything is written: the rows and their lane records the way
 * `table flags` reads them, the Week iteration the next table day falls in, the status updates
 * already posted, and the open board. The writes then run like `table sync`'s: adds first, the rows
 * re-read so each new item has an id, then the cells, then a last read whose plan must be empty.
 * The status update goes last, so it stands only over an agenda that landed whole.
 *
 * **One prep per iteration.** The update names its iteration, and once one stands the agenda is
 * closed: a second run adds no row, carries no bet and posts nothing. It still takes a `proposed`
 * row whose issue closed off the table, since that row must not reach the table.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {appetiteSizesKey} from "../config/keys/appetite-sizes.ts";
import {OUTSIDE_THE_BETS, type TableSettings, tableKey} from "../config/keys/table.ts";
import {readKey} from "../config/read-key.ts";
import {subIssues} from "../io/edges.ts";
import {type Attempt, fail, ok} from "../io/git.ts";
import {
	closedIssuesWithLabel,
	type ListedIssue,
	listOpenIssueFacts,
	resolveRepo,
} from "../io/issues.ts";
import {
	deleteItem,
	type ProjectField,
	type ProjectSnapshot,
	type ProjectsAnswer,
	postStatusUpdate,
	readStatusUpdates,
	type StatusUpdate,
	type StatusUpdateInput,
	withProjects,
} from "../io/projects.ts";
import {EPIC_TYPE_LABEL} from "../triage/facets.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	type AgendaRow,
	admit,
	candidatesOf,
	cellsOf,
	closedProposals,
	describePrepWrite,
	EMPTY_SELECTION,
	type FollowUp,
	onAgenda,
	optionOf,
	type PrepFields,
	type PrepWrite,
	planPrep,
	type Selection,
	type TriageFirst,
	textOf,
} from "./agenda.ts";
import {BET_STAGE} from "./bets.ts";
import {
	CONFIG_MALFORMED,
	NO_ITERATION,
	NOT_SET_UP,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	SCOPE_MISSING,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {type Deciders, type Flag, flagsOf, NOT_ASKED} from "./flags.ts";
import {readHeads, stopOn} from "./flags-read.ts";
import {type FlagsBoard, flagsBoard} from "./flags-verb.ts";
import {type Group, groupOf, kindOf, membersOf} from "./group.ts";
import {
	healthOf,
	healthWindow,
	outsideOf,
	postedFor,
	renderHealth,
	targetIteration,
} from "./health.ts";
import {FIELD} from "./shape.ts";
import type {Row, SyncNode} from "./sync.ts";
import {
	GRAPH_CAP,
	locateTable,
	type Refusal,
	rowsOf,
	type SyncBoard,
	syncBoard,
} from "./sync-verb.ts";

const VERB = "table prep";

/** Every board act the verb takes, passed in so the verb stays provable offline. */
export interface PrepBoard<R>
	extends Pick<FlagsBoard<R>, "locate" | "items" | "node" | "comments" | "week" | "deciders">,
		Pick<SyncBoard<R>, "add" | "set" | "clear"> {
	readonly statusUpdates: (
		projectId: string,
	) => Effect.Effect<ProjectsAnswer<ReadonlyArray<StatusUpdate>>, never, R>;
	/** Every open issue in the repository, with its filer's association. */
	readonly openIssues: (
		repo: string,
	) => Effect.Effect<Attempt<ReadonlyArray<ListedIssue>>, never, R>;
	/** The sub-issues of every closed epic, open or not. */
	readonly followUps: (repo: string) => Effect.Effect<Attempt<ReadonlyArray<FollowUp>>, never, R>;
	readonly remove: (
		projectId: string,
		itemId: string,
	) => Effect.Effect<ProjectsAnswer<string>, never, R>;
	readonly post: (
		projectId: string,
		update: StatusUpdateInput,
	) => Effect.Effect<ProjectsAnswer<string>, never, R>;
}

export interface PrepOptions<R> {
	readonly repo: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now: Date;
	readonly board: PrepBoard<R>;
}

const refused = (code: number, reason: string): Refusal => ({_tag: "Refused", code, reason});

type Resolved =
	| {readonly _tag: "Resolved"; readonly fields: PrepFields}
	| {readonly _tag: "Missing"; readonly what: ReadonlyArray<string>};

/** The fields and options prep writes, or everything the project lacks of them. */
export const prepFields = (project: ProjectSnapshot, settings: TableSettings): Resolved => {
	const lacking: string[] = [];
	const find = (name: string): ProjectField | undefined =>
		project.fields.find((field) => field.name === name);
	const select = (name: string, needs: ReadonlyArray<string>) => {
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
	const text = (name: string): string | null => {
		const field = find(name);
		if (field?._tag !== "Plain" || field.dataType !== "TEXT") {
			lacking.push(`the text field ${name}`);
			return null;
		}
		return field.id;
	};
	const stage = select(FIELD.stage, ["proposed"]);
	const section = select(FIELD.section, settings.sections);
	const size = select(FIELD.size, ["S", "M", "L"]);
	const rec = text(FIELD.rec);
	const plainWords = text(FIELD.plainWords);
	const weekField = find(FIELD.week);
	if (weekField?._tag !== "Iteration") lacking.push(`the iteration field ${FIELD.week}`);
	if (
		stage === null ||
		section === null ||
		size === null ||
		rec === null ||
		plainWords === null ||
		weekField?._tag !== "Iteration" ||
		lacking.length > 0
	) {
		return {_tag: "Missing", what: lacking};
	}
	return {
		_tag: "Resolved",
		fields: {stage, section, size, rec, plainWords, week: weekField.id},
	};
};

/** A number the repository has no issue for: no edges, never open. */
const vanished = (issue: number): SyncNode => ({
	number: issue,
	open: false,
	parent: null,
	subIssues: [],
	blockedBy: [],
	blocking: [],
});

/** The group `head` stands for, reading whatever the graph still lacks into `graph`. */
const groupFor = <R>(
	board: PrepBoard<R>,
	repo: string,
	graph: Map<number, SyncNode>,
	head: number,
): Effect.Effect<Group | Refusal, never, R> =>
	Effect.gen(function* () {
		for (;;) {
			const membership = groupOf(head, graph);
			if (membership._tag === "Derived") return membership.group;
			for (const issue of membership.missing) {
				if (graph.size >= GRAPH_CAP) {
					return refused(
						PRECONDITION_UNKNOWN,
						`${VERB}: the agenda's groups reach past ${GRAPH_CAP} issues. Nothing was written.`,
					);
				}
				const read = yield* board.node(repo, issue);
				if (read._tag === "Unknown") {
					return refused(
						PRECONDITION_UNKNOWN,
						`${VERB}: cannot read #${issue}: ${read.reason}. Nothing was written.`,
					);
				}
				graph.set(issue, read._tag === "Present" ? read.value : vanished(issue));
			}
		}
	});

const stop = (
	failed: Exclude<ProjectsAnswer<unknown>, {_tag: "Ok"}>,
	onFailure: number,
	what: string,
): Refusal =>
	failed._tag === "MissingScope"
		? refused(SCOPE_MISSING, `${VERB}: ${failed.reason}.`)
		: refused(onFailure, `${VERB}: ${what}: ${failed.reason}.`);

const applyAll = <R>(
	board: PrepBoard<R>,
	project: ProjectSnapshot,
	repo: string,
	writes: ReadonlyArray<PrepWrite>,
	landed: string[],
): Effect.Effect<Refusal | null, never, R> =>
	Effect.gen(function* () {
		for (const write of writes) {
			let done: ProjectsAnswer<string>;
			switch (write._tag) {
				case "Add":
					done = yield* board.add(project.id, repo, write.issue);
					break;
				case "Set":
					done = yield* board.set(
						{projectId: project.id, itemId: write.itemId, fieldId: write.fieldId},
						write.value,
					);
					break;
				case "Clear":
					done = yield* board.clear({
						projectId: project.id,
						itemId: write.itemId,
						fieldId: write.fieldId,
					});
					break;
				case "Delete":
					done = yield* board.remove(project.id, write.itemId);
					break;
			}
			if (done._tag !== "Ok") {
				const so = landed.length > 0 ? ` after: ${landed.join("; ")}` : "";
				return stop(
					done,
					WRITE_UNKNOWN,
					`${describePrepWrite(write)} did not land — UNKNOWN${so}; re-run prep to finish`,
				);
			}
			landed.push(describePrepWrite(write));
		}
		return null;
	});

type Converged = {readonly _tag: "Converged"; readonly changes: ReadonlyArray<string>};

/** Apply `plan` until the rows read in step: adds, a re-read, the cells, and an empty last plan. */
const converge = <R>(
	board: PrepBoard<R>,
	project: ProjectSnapshot,
	repo: string,
	first: ReadonlyMap<number, Row>,
	plan: (rows: ReadonlyMap<number, Row>) => ReadonlyArray<PrepWrite>,
): Effect.Effect<Converged | Refusal, never, R> =>
	Effect.gen(function* () {
		const landed: string[] = [];
		const readRows = Effect.map(
			board.items(project.id),
			(items): ProjectsAnswer<ReadonlyMap<number, Row>> =>
				items._tag === "Ok" ? {_tag: "Ok", value: rowsOf(items.value, repo)} : items,
		);

		const adds = plan(first).filter((write) => write._tag === "Add");
		const addFailed = yield* applyAll(board, project, repo, adds, landed);
		if (addFailed !== null) return addFailed;

		let rows: ReadonlyMap<number, Row> = first;
		if (adds.length > 0) {
			const read = yield* readRows;
			if (read._tag !== "Ok") {
				return stop(
					read,
					READBACK_MISMATCH,
					`wrote ${landed.join("; ")} and could not re-read the rows`,
				);
			}
			rows = read.value;
		}
		const values = plan(rows);
		const stray = values.filter((write) => write._tag === "Add");
		if (stray.length > 0) {
			return refused(
				READBACK_MISMATCH,
				`${VERB}: wrote ${landed.join("; ")} and ${stray.map((write) => `#${write.issue}`).join(", ")} still does not read as a row — re-read the project before retrying.`,
			);
		}
		const valuesFailed = yield* applyAll(board, project, repo, values, landed);
		if (valuesFailed !== null) return valuesFailed;

		if (landed.length > 0) {
			const read = yield* readRows;
			if (read._tag !== "Ok") {
				return stop(
					read,
					READBACK_MISMATCH,
					`wrote ${landed.join("; ")} and could not re-read the rows`,
				);
			}
			const settled = plan(read.value);
			if (settled.length > 0) {
				return refused(
					READBACK_MISMATCH,
					`${VERB}: wrote ${landed.join("; ")} and the rows still do not read in step: ${settled.map(describePrepWrite).join("; ")} — re-read the project before retrying.`,
				);
			}
		}
		return {_tag: "Converged", changes: landed};
	});

const numbers = (issues: ReadonlyArray<number>): string =>
	issues.map((issue) => `#${issue}`).join(", ");

export const runPrep = <R>(
	options: PrepOptions<R>,
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
		const resolved = yield* resolveRepo(options.repo, options.env);
		if (resolved._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: no --repo, no CLAUDE_PIPELINE_REPO, no GITHUB_REPOSITORY and no readable origin remote — no repository to prepare the table of.`,
			);
		}
		const repo = resolved.value;
		const {board, now} = options;
		const table = settings.value;

		const heads = yield* readHeads(board, VERB, repo, table, []);
		if (heads._tag === "Refused") return refuse(heads.code, heads.reason);
		const {project} = heads;
		const fields = prepFields(project, table);
		if (fields._tag === "Missing") {
			return refuse(
				NOT_SET_UP,
				`${VERB}: project #${project.number} lacks ${fields.what.join(", ")} — run \`fabrika table setup\` first. Nothing was written.`,
			);
		}

		const history = yield* board.week(project.id);
		if (history._tag !== "Ok") {
			const failed = stopOn(VERB, history, `cannot read the ${FIELD.week} field`);
			return refuse(failed.code, failed.reason);
		}
		const running = history.value?.running ?? [];
		const target = targetIteration(running, table, now);
		if (target === null) {
			return refuse(
				NO_ITERATION,
				`${VERB}: the ${FIELD.week} field runs no iteration covering the next ${table.day} (${running.map((one) => `${one.title} from ${one.startDate}`).join(", ") || "it runs none"}) — add the coming weeks in the project's settings under ${FIELD.week}, then re-run. Prep does not add one: GitHub's API adds an iteration only by rewriting the whole list, which empties every row's ${FIELD.week}. Nothing was written.`,
			);
		}

		const updates = yield* board.statusUpdates(project.id);
		if (updates._tag !== "Ok") {
			const failed = stopOn(VERB, updates, "cannot read the project's status updates");
			return refuse(failed.code, failed.reason);
		}
		const prepped = postedFor(updates.value, target.id);

		const listing = yield* board.openIssues(repo);
		if (listing._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${repo}'s open issues: ${listing.reason}. Nothing was written.`,
			);
		}
		const open = new Map(listing.value.map((issue) => [issue.number, issue] as const));
		const openSet: ReadonlySet<number> = new Set(open.keys());

		const deciders: Deciders = heads.rows.some((row) => row.stage?.name === BET_STAGE)
			? yield* board.deciders(repo)
			: NOT_ASKED;
		const report = flagsOf({
			settings: table,
			sizes: sizes.value,
			now,
			rows: heads.rows,
			records: heads.records,
			deciders,
			campaigns: NOT_ASKED,
			share: NOT_ASKED,
		});
		const rowFlags = report.flags.filter(
			(flag): flag is Extract<Flag, {head: number}> => "head" in flag,
		);
		const flagged = new Map<number, Flag[]>();
		for (const flag of rowFlags) flagged.set(flag.head, [...(flagged.get(flag.head) ?? []), flag]);

		const removals = closedProposals(heads.table, openSet);
		let selection: Selection = EMPTY_SELECTION;
		let triageFirst: ReadonlyArray<TriageFirst> = [];
		let rollover: ReadonlyArray<number> = [];
		if (!prepped) {
			const followUps = yield* board.followUps(repo);
			if (followUps._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read the closed epics' sub-issues: ${followUps.reason}. Nothing was written.`,
				);
			}
			const sorted = candidatesOf({
				settings: table,
				open,
				rows: heads.table,
				followUps: followUps.value,
				flagged,
				target: target.id,
			});
			triageFirst = sorted.triageFirst;
			const graph = new Map(heads.graph);
			for (const candidate of sorted.candidates) {
				const group = yield* groupFor(board, repo, graph, candidate.issue);
				if (group._tag === "Refused") return refuse(group.code, group.reason);
				selection = admit(selection, candidate, group, table.agendaCap);
			}
			const onAgendaNow = new Set(selection.chosen.map((chosen) => chosen.candidate.issue));
			rollover = heads.rows
				.filter(
					(row) =>
						row.stage?.name === BET_STAGE &&
						openSet.has(row.group.head) &&
						!onAgendaNow.has(row.group.head),
				)
				.map((row) => row.group.head)
				.sort((a, b) => a - b);
		}

		const agenda: ReadonlyArray<AgendaRow> = selection.chosen.map((chosen) => ({
			issue: chosen.candidate.issue,
			section: chosen.candidate.section,
			group: chosen.group,
			flaggedBet: chosen.candidate.reason._tag === "Flagged",
			cells:
				chosen.candidate.reason._tag === "Standing"
					? null
					: cellsOf(chosen, open, table, sizes.value),
		}));
		const outside = outsideOf(heads.table, openSet);

		const converged = yield* converge(board, project, repo, heads.table, (rows) =>
			planPrep({
				fields: fields.fields,
				target: {id: target.id, title: target.title},
				rows,
				open: openSet,
				agenda,
				rollover,
				removals,
			}),
		);
		if (converged._tag === "Refused") return refuse(converged.code, converged.reason);
		const {changes} = converged;

		const flaggedBets = agenda.filter((row) => row.flaggedBet).length;
		const health = healthOf({
			window: healthWindow(target),
			records: heads.records,
			flags: report.flags,
			outside,
			continuing: rollover.length,
			flaggedBets,
			inbox: listing.value.filter((issue) => issue.labels.length === 0).length,
		});
		let posted = false;
		if (!prepped) {
			const update = renderHealth(health, target, rowFlags.length > 0);
			const sent = yield* board.post(project.id, update);
			if (sent._tag !== "Ok") {
				const failed = stop(
					sent,
					WRITE_UNKNOWN,
					`the status update did not post — UNKNOWN${changes.length > 0 ? ` after: ${changes.join("; ")}` : ""}; re-run prep to finish`,
				);
				return refuse(failed.code, failed.reason);
			}
			const back = yield* board.statusUpdates(project.id);
			if (back._tag !== "Ok" || !postedFor(back.value, target.id)) {
				return refuse(
					READBACK_MISMATCH,
					`${VERB}: posted the status update for ${target.title} and it does not read back among the project's updates — re-read the project before retrying, or a second update may post.`,
				);
			}
			posted = true;
		}

		const rowsOut = prepped
			? [...heads.table.values()]
					.filter((row) => openSet.has(row.issue) && onAgenda(row, target.id))
					.sort((a, b) => a.issue - b.issue)
					.map((row) => ({
						issue: row.issue,
						section: optionOf(row, FIELD.section),
						kind: null,
						members: [],
						size: optionOf(row, FIELD.size),
						rec: textOf(row, FIELD.rec),
						plainWords: textOf(row, FIELD.plainWords),
					}))
			: agenda.map((row) => ({
					issue: row.issue,
					section: row.section,
					kind: kindOf(row.group),
					members: membersOf(row.group),
					size: row.cells?.size ?? optionOf(heads.table.get(row.issue), FIELD.size),
					rec: row.cells?.rec ?? textOf(heads.table.get(row.issue), FIELD.rec),
					plainWords: row.cells?.plainWords ?? textOf(heads.table.get(row.issue), FIELD.plainWords),
				}));
		const notes = [
			`${VERB}: read ${settings.note}; ${sizes.note}.`,
			`${VERB}: project #${project.number} "${project.title}" (${project.url}); preparing ${FIELD.week} ${target.title} (from ${target.startDate}).`,
			...(prepped
				? [
						`${VERB}: the status update for ${target.title} already stands, so its agenda is closed — no row added, no bet carried, nothing posted.`,
					]
				: [
						`${VERB}: ${rowsOut.length} agenda row(s) of ${table.agendaCap}${selection.overflow.length > 0 ? `; left for a later table: ${numbers(selection.overflow)}` : ""}.`,
						...agenda
							.filter((row) => row.group._tag !== "Single")
							.map(
								(row) =>
									`${VERB}: #${row.issue} is a ${kindOf(row.group)} row over ${membersOf(row.group).length === 0 ? "no open member" : numbers(membersOf(row.group))}.`,
							),
						...(rollover.length > 0
							? [`${VERB}: carried into ${target.title}: ${numbers(rollover)}.`]
							: []),
					]),
			...triageFirst.map(
				(one) =>
					`${VERB}: #${one.issue} is a Customers report to triage first${one.waitingOnFiler ? " — waiting on filer" : ""}.`,
			),
			...(outside.count > 0
				? [
						`${VERB}: ${OUTSIDE_THE_BETS}: ${outside.count} running lane(s), $${outside.spentUsd}${outside.unmeasured > 0 ? ` measured with ${outside.unmeasured} not measured` : ""}.`,
					]
				: []),
			...report.unread.map(
				(one) =>
					`${VERB}: ${one.check}${one.issue === null ? "" : ` on #${one.issue}`} unread: ${one.reason}.`,
			),
			...changes.map((change) => `${VERB}: ${change}.`),
			...(posted ? [`${VERB}: posted the status update for ${target.title}.`] : []),
			...(changes.length === 0 && !posted ? [`${VERB}: nothing was written.`] : []),
		];
		return answer(
			`${JSON.stringify({
				answer: changes.length > 0 || posted ? "prepped" : "unchanged",
				repo,
				project: {number: project.number, title: project.title, url: project.url},
				iteration: {id: target.id, title: target.title, startDate: target.startDate},
				agenda: rowsOut,
				overflow: selection.overflow,
				rollover: {
					continuing: rollover,
					flagged: agenda.filter((row) => row.flaggedBet).map((row) => row.issue),
				},
				removed: removals,
				triageFirst,
				outside,
				health: {posted, alreadyPosted: prepped, ...health},
				changes,
			})}\n`,
			notes,
		);
	});

/** The sub-issues of every closed epic, read off the native graph. */
const readFollowUps = (repo: string) =>
	Effect.gen(function* () {
		const epics = yield* closedIssuesWithLabel(repo, EPIC_TYPE_LABEL);
		if (epics._tag === "Failure") return epics;
		const found: FollowUp[] = [];
		for (const epic of epics.value) {
			if (!epic.mayHaveOpenChildren) continue;
			const children = yield* subIssues(repo, epic.number);
			if (children._tag === "Unknown")
				return fail(`#${epic.number}'s sub-issues: ${children.reason}`);
			if (children._tag === "Absent") continue;
			for (const issue of children.value) found.push({issue, epic: epic.number});
		}
		return ok<ReadonlyArray<FollowUp>>(found);
	});

/** The shipped board: GitHub, under the ambient token. */
export const prepBoard: PrepBoard<
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = {
	locate: (repo, settings) => withProjects((token) => locateTable(token, repo, settings, VERB)),
	items: syncBoard.items,
	node: syncBoard.node,
	comments: syncBoard.comments,
	week: flagsBoard.week,
	deciders: flagsBoard.deciders,
	add: syncBoard.add,
	set: syncBoard.set,
	clear: syncBoard.clear,
	statusUpdates: (projectId) => withProjects((token) => readStatusUpdates(token, projectId)),
	openIssues: listOpenIssueFacts,
	followUps: readFollowUps,
	remove: (projectId, itemId) => withProjects((token) => deleteItem(token, projectId, itemId)),
	post: (projectId, update) => withProjects((token) => postStatusUpdate(token, projectId, update)),
};
