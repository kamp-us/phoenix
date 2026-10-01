/**
 * `table prep` — fill the next table's agenda, carry the running bets to it, bring the bets shipped
 * long enough ago back as checks, and post the week's health as the project's status update. Every
 * row it touches is dated with the next table's day in the Table day field.
 *
 * Everything is read before anything is written: the rows and their lane records the way
 * `table flags` reads them, the status updates already posted, the open board, and each check's evidence. Check comments post first, so a re-run
 * after a later write fails still finds them and posts none twice. The row writes then run like
 * `table sync`'s: adds first, the rows re-read so each new item has an id, then the cells, then a
 * last read whose plan must be empty. The status update goes last, so it stands only over an agenda
 * that landed whole.
 *
 * **One prep per table.** The update names its table day, and once one stands the agenda is
 * closed: a second run adds no row, carries no bet and posts nothing. It still takes a `proposed`
 * row whose issue closed off the table, since that row must not reach the table.
 *
 * **Prep never routes.** It reads the on-call board to leave routed issues off the agenda and to
 * report on-call as one section of the update, and it leaves their table rows standing. Placing
 * them and taking their rows off is `table route`'s, which runs on any schedule without closing an
 * agenda, so an issue routed by its row's Origin is never on neither board.
 *
 * `--dry-run` runs this same path over a board that records its writes (`dry-run.ts`).
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 * @ruling https://github.com/kamp-us/phoenix/issues/9989
 * @ruling https://github.com/kamp-us/phoenix/issues/10086
 * @ruling https://github.com/kamp-us/phoenix/issues/9872#issuecomment-5852556900
 * @ruling https://github.com/kamp-us/phoenix/issues/10302
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {appetiteSizesKey} from "../config/keys/appetite-sizes.ts";
import {boardsKey} from "../config/keys/boards.ts";
import {OUTSIDE_THE_BETS, type TableSettings, tableKey} from "../config/keys/table.ts";
import {readKey} from "../config/read-key.ts";
import {subIssues} from "../io/edges.ts";
import {execRecord} from "../io/exec.ts";
import {type Attempt, fail, ok} from "../io/git.ts";
import {
	type CommentRecord,
	closedIssuesWithLabel,
	createComment,
	getIssue,
	type ListedIssue,
	listComments,
	listOpenIssueFacts,
	resolveRepo,
	timelineFacts,
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
	CHECK_STAGE,
	candidatesOf,
	cellsOf,
	closedProposals,
	EMPTY_SELECTION,
	type FollowUp,
	onAgenda,
	optionOf,
	PROPOSED,
	type PrepFields,
	type PrepInput,
	planPrep,
	prepPlan,
	type Selection,
	type TriageFirst,
	textOf,
} from "./agenda.ts";
import {BET_STAGE} from "./bets.ts";
import {dueChecks} from "./check.ts";
import {type CheckBoard, type GatheredCheck, gatherChecks} from "./check-read.ts";
import {
	CONFIG_MALFORMED,
	NOT_SET_UP,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {type ConvergeBoard, converge, stopOnWrite} from "./converge.ts";
import {describePlanned, dryRunPrep} from "./dry-run.ts";
import {
	type Deciders,
	type Flag,
	flagName,
	flagsOf,
	NOT_ASKED,
	onCallSpendOf,
	recOf,
} from "./flags.ts";
import {readHeads, stopOn} from "./flags-read.ts";
import {type FlagsBoard, flagsBoard} from "./flags-verb.ts";
import {type Group, groupOf, kindOf, membersOf} from "./group.ts";
import {
	flagCount,
	healthOf,
	type OnCallHealth,
	outsideOf,
	postedFor,
	renderHealth,
} from "./health.ts";
import {responseTargetOf} from "./on-call.ts";
import {onCallIssuesOf, onCallItemsOf, readOnCall} from "./on-call-prep.ts";
import {type RuledUnbuilt, ruledSuspects, ruledUnbuiltOf} from "./ruled.ts";
import {FIELD} from "./shape.ts";
import type {Row, SyncNode} from "./sync.ts";
import {
	GRAPH_CAP,
	githubWave,
	locateTable,
	type Refusal,
	readEach,
	readNodes,
	syncBoard,
} from "./sync-verb.ts";
import {nextTableDay, weekBefore} from "./table-day.ts";

const VERB = "table prep";

/** Every board act the verb takes, passed in so the verb stays provable offline. */
export interface PrepBoard<R>
	extends Pick<FlagsBoard<R>, "locate" | "items" | "node" | "comments" | "wave" | "deciders">,
		ConvergeBoard<R>,
		CheckBoard<R> {
	/** Post a comment on the issue: a check's evidence. */
	readonly comment: (
		repo: string,
		issue: number,
		body: string,
	) => Effect.Effect<Attempt<unknown>, never, R>;
	readonly statusUpdates: (
		projectId: string,
	) => Effect.Effect<ProjectsAnswer<ReadonlyArray<StatusUpdate>>, never, R>;
	/** Every open issue in the repository, with its filer's association. */
	readonly openIssues: (
		repo: string,
	) => Effect.Effect<Attempt<ReadonlyArray<ListedIssue>>, never, R>;
	/** The sub-issues of every closed epic, open or not. */
	readonly followUps: (repo: string) => Effect.Effect<Attempt<ReadonlyArray<FollowUp>>, never, R>;
	/** Every comment on the issue with its author and stamps: where a ruling marker is read. */
	readonly rulings: (
		repo: string,
		issue: number,
	) => Effect.Effect<Attempt<ReadonlyArray<CommentRecord>>, never, R>;
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
	/** Run over a board that records every write and sends none, and print the plan. */
	readonly dryRun: boolean;
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
	const stage = select(FIELD.stage, [PROPOSED, CHECK_STAGE]);
	const section = select(FIELD.section, settings.sections);
	const size = select(FIELD.size, ["S", "M", "L"]);
	const rec = text(FIELD.rec);
	const plainWords = text(FIELD.plainWords);
	const dayField = find(FIELD.tableDay);
	const tableDay = dayField?._tag === "Plain" && dayField.dataType === "DATE" ? dayField.id : null;
	if (tableDay === null) lacking.push(`the date field ${FIELD.tableDay}`);
	if (
		stage === null ||
		section === null ||
		size === null ||
		rec === null ||
		plainWords === null ||
		tableDay === null ||
		lacking.length > 0
	) {
		return {_tag: "Missing", what: lacking};
	}
	return {
		_tag: "Resolved",
		fields: {stage, section, size, rec, plainWords, tableDay},
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

/**
 * Read what the heads' groups lack into `graph`, a few at a time, before {@link groupFor} walks the
 * heads in order. An unreadable issue is left out rather than refused on, so `groupFor` re-reads it
 * and refuses where the in-order walk reaches it; a wave that would pass {@link GRAPH_CAP} is left
 * to `groupFor` to refuse.
 */
const prefetchGroups = <R>(
	board: PrepBoard<R>,
	repo: string,
	graph: Map<number, SyncNode>,
	heads: ReadonlyArray<number>,
): Effect.Effect<void, never, R> =>
	Effect.gen(function* () {
		const unread = new Set<number>();
		for (;;) {
			const lacking = heads.flatMap((head) => {
				const membership = groupOf(head, graph);
				return membership._tag === "Derived" ? [] : membership.missing;
			});
			const wanted = [...new Set(lacking)].filter((n) => !graph.has(n) && !unread.has(n));
			if (wanted.length === 0 || graph.size + wanted.length > GRAPH_CAP) return;
			for (const [issue, read] of yield* readNodes(board, repo, wanted)) {
				if (read._tag === "Unknown") unread.add(issue);
				else graph.set(issue, read._tag === "Present" ? read.value : vanished(issue));
			}
		}
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

const numbers = (issues: ReadonlyArray<number>): string =>
	issues.map((issue) => `#${issue}`).join(", ");

/**
 * The rulings no one has built, read off each suspect's comments against the control-plane roster.
 * An unread roster or comment list refuses: an issue it could not read is neither ruled nor unruled.
 */
const readRuled = <R>(
	board: PrepBoard<R>,
	repo: string,
	suspects: ReadonlyArray<number>,
	deciders: Deciders,
): Effect.Effect<
	{readonly _tag: "Read"; readonly ruled: ReadonlyArray<RuledUnbuilt>} | Refusal,
	never,
	R
> =>
	Effect.gen(function* () {
		if (suspects.length === 0) return {_tag: "Read" as const, ruled: []};
		if (deciders._tag !== "Roster") {
			const why = deciders._tag === "Unread" ? deciders.reason : "the roster was not read";
			return refused(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot tell which rulings stand: ${why}. Nothing was written.`,
			);
		}
		const reads: Array<readonly [number, ReadonlyArray<CommentRecord>]> = [];
		for (const [issue, read] of yield* readEach(suspects, (issue) => board.rulings(repo, issue))) {
			if (read._tag === "Failure") {
				return refused(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read #${issue}'s comments for a ruling: ${read.reason}. Nothing was written.`,
				);
			}
			reads.push([issue, read.value]);
		}
		return {_tag: "Read" as const, ruled: ruledUnbuiltOf(reads, deciders.logins)};
	});

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
		const boards = yield* readKey(options.cwd, boardsKey);
		if (boards._tag === "Refused") {
			return refuse(CONFIG_MALFORMED, `${VERB}: ${boards.reason}. Nothing was read from GitHub.`);
		}
		const resolved = yield* resolveRepo(options.repo, options.env);
		if (resolved._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: no --repo, no CLAUDE_PIPELINE_REPO, no GITHUB_REPOSITORY and no readable origin remote — no repository to prepare the table of.`,
			);
		}
		const repo = resolved.value;
		const {now} = options;
		const dry = options.dryRun ? dryRunPrep(options.board, now.toISOString()) : null;
		const board = dry?.board ?? options.board;
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

		const target = nextTableDay(table, now);

		const updates = yield* board.statusUpdates(project.id);
		if (updates._tag !== "Ok") {
			const failed = stopOn(VERB, updates, "cannot read the project's status updates");
			return refuse(failed.code, failed.reason);
		}
		const prepped = postedFor(updates.value, target);

		const listing = yield* board.openIssues(repo);
		if (listing._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${repo}'s open issues: ${listing.reason}. Nothing was written.`,
			);
		}
		const open = new Map(listing.value.map((issue) => [issue.number, issue] as const));
		const openSet: ReadonlySet<number> = new Set(open.keys());

		const due = dueChecks(heads.rows, table.checkDelayDays, now);
		const onCallRead = yield* readOnCall(board, VERB, repo, boards.value);
		if (onCallRead._tag === "Refused") return refuse(onCallRead.code, onCallRead.reason);
		const split = onCallRead._tag === "Split" ? onCallRead : null;
		const routed =
			split === null ? [] : onCallIssuesOf(open, heads.table, heads.rows, split.settings, due);
		const routedSet: ReadonlySet<number> = new Set(routed.map((issue) => issue.number));
		const onCallIssues: ReadonlySet<number> = new Set([
			...(split?.rows.keys() ?? []),
			...routedSet,
		]);
		const window = weekBefore(target, table.timeZone);
		const onCallOpen = split === null ? [] : onCallItemsOf(split.rows, open, routed);

		const suspects = prepped ? [] : ruledSuspects(open);
		const deciders: Deciders =
			suspects.length > 0 || heads.rows.some((row) => row.stage?.name === BET_STAGE)
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
			onCall:
				split === null
					? NOT_ASKED
					: {
							_tag: "OnCall",
							settings: split.settings,
							boardCreatedAt: split.project.createdAt,
							issues: onCallIssues,
							open: onCallOpen,
							week: {_tag: "Week", ...window},
						},
		});
		const onCallFlagged = report.flags.filter(
			(flag) => flag._tag === "PastTarget" || flag._tag === "OnCallShare",
		);
		const rowFlags = report.flags.filter(
			(flag): flag is Extract<Flag, {head: number}> => "head" in flag,
		);
		const flagged = new Map<number, Flag[]>();
		for (const flag of rowFlags) flagged.set(flag.head, [...(flagged.get(flag.head) ?? []), flag]);

		const removals = closedProposals(heads.table, openSet);
		let selection: Selection = EMPTY_SELECTION;
		let triageFirst: ReadonlyArray<TriageFirst> = [];
		let rollover: ReadonlyArray<number> = [];
		let checks: ReadonlyArray<GatheredCheck> = [];
		let vanished: ReadonlyArray<number> = [];
		let ruled: ReadonlyArray<RuledUnbuilt> = [];
		if (!prepped) {
			const followUps = yield* board.followUps(repo);
			if (followUps._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read the closed epics' sub-issues: ${followUps.reason}. Nothing was written.`,
				);
			}
			const rulings = yield* readRuled(board, repo, suspects, deciders);
			if (rulings._tag === "Refused") return refuse(rulings.code, rulings.reason);
			ruled = rulings.ruled;
			const sorted = candidatesOf({
				settings: table,
				open,
				rows: heads.table,
				followUps: followUps.value,
				flagged,
				ruled,
				target,
				onCall: routedSet,
			});
			triageFirst = sorted.triageFirst;
			const graph = new Map(heads.graph);
			yield* prefetchGroups(
				board,
				repo,
				graph,
				sorted.candidates.map((candidate) => candidate.issue),
			);
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

			const gathered = yield* gatherChecks(board, {
				verb: VERB,
				repo,
				cwd: options.cwd,
				env: options.env,
				settings: table,
				now,
				due,
				records: heads.records,
			});
			if (gathered._tag === "Refused") return refuse(gathered.code, gathered.reason);
			({checks, vanished} = gathered);
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
		const outside = outsideOf(heads.table, openSet, onCallIssues);

		const commented: number[] = [];
		for (const check of checks) {
			if (check.comment === null) continue;
			const sent = yield* board.comment(repo, check.evidence.issue, check.comment);
			if (sent._tag === "Failure") {
				const so = commented.length > 0 ? ` after the check comments on ${numbers(commented)}` : "";
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: the check comment on #${check.evidence.issue} did not post — UNKNOWN${so}: ${sent.reason}; re-run prep to finish.`,
				);
			}
			commented.push(check.evidence.issue);
		}

		const planInput = (rows: ReadonlyMap<number, Row>): PrepInput => ({
			fields: fields.fields,
			target,
			rows,
			open: openSet,
			agenda,
			rollover,
			removals,
			checks: checks.map((check) => check.row),
			onCall: routedSet,
		});
		const {kept} = prepPlan(planInput(heads.table));
		const converged = yield* converge(VERB, board, project, repo, heads.table, (rows) =>
			planPrep(planInput(rows)),
		);
		if (converged._tag === "Refused") return refuse(converged.code, converged.reason);
		const {changes} = converged;

		const onCallHealth: OnCallHealth | null =
			split === null
				? null
				: {
						open: onCallOpen.length,
						pastTarget: flagCount(report, "PastTarget", "past-target"),
						spend: onCallSpendOf(heads.records, window, onCallIssues),
						share: split.settings.spendShare,
					};

		const flaggedBets = agenda.filter((row) => row.flaggedBet).length;
		const health = healthOf({
			window,
			records: heads.records,
			report,
			outside,
			continuing: rollover.length,
			flaggedBets,
			inbox: listing.value.filter((issue) => issue.labels.length === 0).length,
			ruled,
		});
		let posted = false;
		if (!prepped) {
			const update = renderHealth(
				health,
				target,
				rowFlags.length > 0 || onCallFlagged.length > 0,
				onCallHealth,
			);
			const sent = yield* board.post(project.id, update);
			if (sent._tag !== "Ok") {
				const failed = stopOnWrite(
					VERB,
					sent,
					WRITE_UNKNOWN,
					`the status update did not post — UNKNOWN${changes.length > 0 ? ` after: ${changes.join("; ")}` : ""}; re-run prep to finish`,
				);
				return refuse(failed.code, failed.reason);
			}
			const back = yield* board.statusUpdates(project.id);
			if (back._tag !== "Ok" || !postedFor(back.value, target)) {
				return refuse(
					READBACK_MISMATCH,
					`${VERB}: posted the status update for the ${target} table and it does not read back among the project's updates — re-read the project before retrying, or a second update may post.`,
				);
			}
			posted = true;
		}

		const rowsOut = prepped
			? [...heads.table.values()]
					.filter(
						(row) => openSet.has(row.issue) && !routedSet.has(row.issue) && onAgenda(row, target),
					)
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
					rec: textOf(heads.table.get(row.issue), FIELD.rec) ?? row.cells?.rec ?? null,
					plainWords: row.cells?.plainWords ?? textOf(heads.table.get(row.issue), FIELD.plainWords),
				}));
		const wrote = changes.length > 0 || commented.length > 0 || posted;
		const planned = dry?.planned() ?? null;
		const notes = [
			...(planned === null
				? []
				: [`${VERB}: --dry-run: every write below is planned and none was sent.`]),
			`${VERB}: read ${settings.note}; ${sizes.note}${split === null ? "" : `; ${boards.note}`}.`,
			`${VERB}: project #${project.number} "${project.title}" (${project.url}); preparing the ${table.day} ${target} table (${FIELD.tableDay}, read in ${table.timeZone}).`,
			...(prepped
				? [
						`${VERB}: the status update for the ${target} table already stands, so its agenda is closed — no row added, no bet carried, nothing posted.`,
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
							? [`${VERB}: carried to the ${target} table: ${numbers(rollover)}.`]
							: []),
						...(ruled.length > 0
							? [
									`${VERB}: ruled and not built, oldest ruling first: ${numbers(ruled.map((one) => one.issue))}.`,
								]
							: []),
					]),
			...checks.map(
				(check) =>
					`${VERB}: #${check.evidence.issue} is back as a check, shipped ${check.evidence.shippedAt.slice(0, 10)}; its evidence ${check.comment === null ? "already stands" : planned === null ? "was posted" : "would post"} on the issue.`,
			),
			...kept.map(
				(one) =>
					`${VERB}: left #${one.issue}'s Rec as it reads: "${one.rec}"${one.wanted === null ? "" : ` (prep's text would be "${one.wanted}")`}.`,
			),
			...checks.flatMap((check) =>
				check.evidence.sources.flatMap((source) =>
					source._tag === "Failed"
						? [
								`${VERB}: evidence source "${source.name}" on #${check.evidence.issue} failed: ${source.reason}.`,
							]
						: [],
				),
			),
			...vanished.map(
				(issue) => `${VERB}: #${issue} is shipped and due a check, but it is no issue any more.`,
			),
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
			...(split === null || onCallHealth === null
				? []
				: [
						`${VERB}: on-call board #${split.project.number} "${split.project.title}" (${split.project.url}): ${onCallHealth.open} open item(s), ${onCallHealth.pastTarget._tag === "Counted" ? onCallHealth.pastTarget.count : `at least ${onCallHealth.pastTarget.atLeast}`} past its response target; the table reviews it as one section of the status update.`,
						...onCallFlagged.map(
							(flag) =>
								`${VERB}: ${flagName(flag)}${flag._tag === "PastTarget" ? ` on #${flag.issue}` : ""}: ${recOf(flag, table)}`,
						),
					]),
			...(planned === null
				? [
						...changes.map((change) => `${VERB}: ${change}.`),
						...(posted ? [`${VERB}: posted the status update for the ${target} table.`] : []),
						...(wrote ? [] : [`${VERB}: nothing was written.`]),
					]
				: [
						...planned.map((write) => `${VERB}: would ${describePlanned(write)}.`),
						`${VERB}: --dry-run: nothing was written.`,
					]),
		];
		return answer(
			`${JSON.stringify({
				answer: planned !== null ? "dry-run" : wrote ? "prepped" : "unchanged",
				repo,
				project: {number: project.number, title: project.title, url: project.url},
				tableDay: target,
				agenda: rowsOut,
				overflow: selection.overflow,
				rollover: {
					continuing: rollover,
					flagged: agenda.filter((row) => row.flaggedBet).map((row) => row.issue),
				},
				removed: removals,
				checks: checks.map((check) => ({
					...check.evidence,
					rec: check.row.rec,
					comment: check.comment === null ? "standing" : planned === null ? "posted" : "planned",
				})),
				triageFirst,
				outside,
				health: {posted: posted && planned === null, alreadyPosted: prepped, ...health},
				recsKept: kept,
				changes: planned === null ? changes : [],
				...(planned === null ? {} : {planned}),
				...(split === null || onCallHealth === null
					? {}
					: {
							onCall: {
								project: {
									number: split.project.number,
									title: split.project.title,
									url: split.project.url,
								},
								items: onCallOpen.map((item) => ({
									issue: item.issue,
									target: responseTargetOf(item.labels, split.settings.responseTargets).name,
								})),
								pastTarget: onCallFlagged.flatMap((flag) =>
									flag._tag === "PastTarget" ? [flag.issue] : [],
								),
								spend: onCallHealth.spend,
								share: onCallHealth.share,
							},
						}),
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
	locate: (repo, target) => withProjects((token) => locateTable(token, repo, target, VERB)),
	items: syncBoard.items,
	node: syncBoard.node,
	comments: syncBoard.comments,
	wave: githubWave,
	deciders: flagsBoard.deciders,
	add: syncBoard.add,
	set: syncBoard.set,
	clear: syncBoard.clear,
	statusUpdates: (projectId) => withProjects((token) => readStatusUpdates(token, projectId)),
	openIssues: listOpenIssueFacts,
	followUps: readFollowUps,
	rulings: listComments,
	remove: (projectId, itemId) => withProjects((token) => deleteItem(token, projectId, itemId)),
	issue: getIssue,
	timeline: timelineFacts,
	comment: createComment,
	source: execRecord,
	post: (projectId, update) => withProjects((token) => postStatusUpdate(token, projectId, update)),
};
