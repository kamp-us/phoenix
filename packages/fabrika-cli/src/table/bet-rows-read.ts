/**
 * Read the table's `bet` rows with the issues each stands for: the project's items first, then the
 * issue graph out from every bet row until each row's group is decidable.
 *
 * A graph read that fails makes the whole read `Unknown`, because a group with a member missing
 * would approve fewer issues than the table said yes to, or more.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9913
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {blockedBy, subIssues} from "../io/edges.ts";
import type {Shell} from "../io/git.ts";
import {absent, type Existence, getIssue, present, unknown} from "../io/issues.ts";
import {readItems} from "../io/projects.ts";
import {type BetRow, betCellsOf, betRowsOf} from "./bet-rows.ts";
import {readTableWith, type TableRead} from "./bets-read.ts";
import {graphOf, type IssueNode} from "./group.ts";

/** How many issues one read may pull into its graph before it stops rather than walk on. */
export const BET_GRAPH_CAP = 500;

const readNode = (repo: string, issue: number): Shell<Existence<IssueNode>> =>
	Effect.gen(function* () {
		const found = yield* getIssue(repo, issue);
		if (found._tag !== "Present") return found;
		if (found.value.isPullRequest) return absent<IssueNode>();
		const children = yield* subIssues(repo, issue);
		if (children._tag !== "Present") {
			return unknown<IssueNode>(
				children._tag === "Unknown" ? children.reason : `#${issue}'s sub-issues vanished mid-read`,
			);
		}
		const blockers = yield* blockedBy(repo, issue);
		if (blockers._tag !== "Present") {
			return unknown<IssueNode>(
				blockers._tag === "Unknown" ? blockers.reason : `#${issue}'s blockers vanished mid-read`,
			);
		}
		return present<IssueNode>({
			number: issue,
			open: found.value.state === "open",
			parent: found.value.parent._tag === "Parent" ? found.value.parent.number : null,
			subIssues: children.value,
			blockedBy: blockers.value,
		});
	});

/** A number the repository has no issue for: no edges, never open. */
const vanished = (issue: number): IssueNode => ({
	number: issue,
	open: false,
	parent: null,
	subIssues: [],
	blockedBy: [],
});

export const readBetRows = (
	cwd: string,
	repo: string,
): Effect.Effect<
	TableRead<ReadonlyArray<BetRow>>,
	never,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const items = yield* readTableWith(cwd, repo, (token, projectId) =>
			readItems(token, projectId),
		);
		if (items._tag !== "Read") return items;
		const cells = betCellsOf(items.value, repo);
		const graph = new Map<number, IssueNode>();
		let wanted: ReadonlyArray<number> = [...new Set(cells.map((cell) => cell.head))];
		for (;;) {
			for (const issue of wanted) {
				if (graph.size >= BET_GRAPH_CAP) {
					return {
						_tag: "Unknown",
						reason: `the groups of the table's bet rows reach past ${BET_GRAPH_CAP} issues`,
					};
				}
				const node = yield* readNode(repo, issue);
				if (node._tag === "Unknown") {
					return {_tag: "Unknown", reason: `cannot read #${issue}: ${node.reason}`};
				}
				graph.set(issue, node._tag === "Present" ? node.value : vanished(issue));
			}
			const rows = betRowsOf(cells, graphOf(graph.values()));
			if (rows._tag === "Derived") return {_tag: "Read", source: items.source, value: rows.rows};
			wanted = rows.missing.filter((issue) => !graph.has(issue));
			if (wanted.length === 0) {
				return {_tag: "Unknown", reason: "the bet rows' groups did not settle on a full graph"};
			}
		}
	});
