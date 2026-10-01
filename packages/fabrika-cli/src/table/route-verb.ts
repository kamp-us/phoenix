/**
 * `table route` — put every open issue `boards.onCall.route` sends to on-call on the on-call board,
 * take each off the table, and keep each item's Response target the one its labels pick now.
 *
 * **Safe on any schedule.** It closes no agenda, dates no row and posts no update, so it can run as
 * often as on-call needs without moving the table. Which issues leave is `onCallIssuesOf` over the
 * same rows, groups and due checks prep reads, so the two never disagree about an issue. The
 * on-call board is written first and the table after, so a run that stops between them leaves an
 * issue on both boards, never on neither. A second run over the same issues writes nothing.
 *
 * `--dry-run` runs this same path over a board that records its writes (`dry-run.ts`).
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10302
 * @ruling https://github.com/kamp-us/phoenix/issues/10086
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {boardsKey} from "../config/keys/boards.ts";
import {tableKey} from "../config/keys/table.ts";
import {readKey} from "../config/read-key.ts";
import type {Attempt} from "../io/git.ts";
import {type ListedIssue, listOpenIssueFacts, resolveRepo} from "../io/issues.ts";
import {deleteItem, withProjects} from "../io/projects.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import type {PrepWrite} from "./agenda.ts";
import {dueChecks} from "./check.ts";
import {CONFIG_MALFORMED, NOT_SET_UP, PRECONDITION_UNKNOWN} from "./codes.ts";
import {type ConvergeBoard, converge} from "./converge.ts";
import {describePlanned, dryRunRoute} from "./dry-run.ts";
import {readHeads} from "./flags-read.ts";
import {onCallFields, onCallIssuesOf, planOnCall, readOnCall} from "./on-call-prep.ts";
import type {Row} from "./sync.ts";
import {githubWave, locateTable, syncBoard, type TableBoard} from "./sync-verb.ts";

const VERB = "table route";

/** Every board act the verb takes, passed in so the verb stays provable offline. */
export interface RouteBoard<R> extends TableBoard<R>, ConvergeBoard<R> {
	/** Every open issue in the repository: what the routing rule reads. */
	readonly openIssues: (
		repo: string,
	) => Effect.Effect<Attempt<ReadonlyArray<ListedIssue>>, never, R>;
}

export interface RouteOptions<R> {
	readonly repo: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now: Date;
	readonly board: RouteBoard<R>;
	/** Run over a board that records every write and sends none, and print the plan. */
	readonly dryRun: boolean;
}

/** The table rows of the routed issues: each one the run takes off. */
const offTable = (
	rows: ReadonlyMap<number, Row>,
	routed: ReadonlyArray<ListedIssue>,
): ReadonlyArray<PrepWrite> =>
	routed.flatMap((issue): PrepWrite[] => {
		const row = rows.get(issue.number);
		return row === undefined ? [] : [{_tag: "Delete", issue: row.issue, itemId: row.itemId}];
	});

export const runRoute = <R>(
	options: RouteOptions<R>,
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
		const boards = yield* readKey(options.cwd, boardsKey);
		if (boards._tag === "Refused") {
			return refuse(CONFIG_MALFORMED, `${VERB}: ${boards.reason}. Nothing was read from GitHub.`);
		}
		const resolved = yield* resolveRepo(options.repo, options.env);
		if (resolved._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: no --repo, no CLAUDE_PIPELINE_REPO, no GITHUB_REPOSITORY and no readable origin remote — no repository to route the issues of.`,
			);
		}
		const repo = resolved.value;
		const {now} = options;
		const dry = options.dryRun ? dryRunRoute(options.board, now.toISOString()) : null;
		const board = dry?.board ?? options.board;
		const split = yield* readOnCall(board, VERB, repo, boards.value);
		if (split._tag === "Refused") return refuse(split.code, split.reason);
		if (split._tag === "One") {
			return answer(
				`${JSON.stringify({
					answer: dry === null ? "unchanged" : "dry-run",
					repo,
					onCall: null,
					routed: [],
					changes: [],
					...(dry === null ? {} : {planned: []}),
				})}\n`,
				[
					`${VERB}: no \`boards\` block splits the work, so there is no on-call board to route to.`,
					`${VERB}: ${dry === null ? "" : "--dry-run: "}nothing was written.`,
				],
			);
		}

		const fields = onCallFields(split.project, split.settings);
		if (fields._tag === "Missing") {
			return refuse(
				NOT_SET_UP,
				`${VERB}: the on-call board #${split.project.number} lacks ${fields.what.join(", ")} — run \`fabrika table setup\` first. Nothing was written.`,
			);
		}
		const heads = yield* readHeads(board, VERB, repo, settings.value, []);
		if (heads._tag === "Refused") return refuse(heads.code, heads.reason);
		const listing = yield* board.openIssues(repo);
		if (listing._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${repo}'s open issues: ${listing.reason}. Nothing was written.`,
			);
		}
		const open = new Map(listing.value.map((issue) => [issue.number, issue] as const));
		const due = dueChecks(heads.rows, settings.value.checkDelayDays, now);
		const routed = onCallIssuesOf(open, heads.table, heads.rows, split.settings, due);

		const placed = yield* converge(
			VERB,
			board,
			split.project,
			repo,
			split.rows,
			(rows) => planOnCall({fields: fields.fields, settings: split.settings, rows, issues: routed}),
			"the on-call board",
		);
		if (placed._tag === "Refused") return refuse(placed.code, placed.reason);
		const left = yield* converge(VERB, board, heads.project, repo, heads.table, (rows) =>
			offTable(rows, routed),
		);
		if (left._tag === "Refused") {
			const so =
				placed.changes.length > 0 && dry === null
					? ` The on-call board took: ${placed.changes.join("; ")}.`
					: "";
			return refuse(left.code, `${left.reason}${so}`);
		}

		const planned = dry?.planned() ?? null;
		const changes = planned === null ? [...placed.changes, ...left.changes] : [];
		const {project} = split;
		return answer(
			`${JSON.stringify({
				answer: planned !== null ? "dry-run" : changes.length > 0 ? "routed" : "unchanged",
				repo,
				onCall: {number: project.number, title: project.title, url: project.url},
				routed: routed.map((issue) => issue.number),
				changes,
				...(planned === null ? {} : {planned}),
			})}\n`,
			[
				`${VERB}: read ${settings.note}; ${boards.note}.`,
				`${VERB}: on-call board #${project.number} "${project.title}" (${project.url}); ${routed.length} open issue(s) route there.`,
				...(planned !== null
					? [
							...planned.map((write) => `${VERB}: would ${describePlanned(write)}.`),
							`${VERB}: --dry-run: nothing was written.`,
						]
					: changes.length > 0
						? changes.map((change) => `${VERB}: ${change}.`)
						: [`${VERB}: nothing was written.`]),
			],
		);
	});

/** The shipped board: GitHub, under the ambient token. */
export const routeBoard: RouteBoard<ChildProcessSpawner.ChildProcessSpawner> = {
	locate: (repo, target) => withProjects((token) => locateTable(token, repo, target, VERB)),
	items: syncBoard.items,
	node: syncBoard.node,
	comments: syncBoard.comments,
	wave: githubWave,
	add: syncBoard.add,
	set: syncBoard.set,
	clear: syncBoard.clear,
	remove: (projectId, itemId) => withProjects((token) => deleteItem(token, projectId, itemId)),
	openIssues: listOpenIssueFacts,
};
