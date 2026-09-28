/**
 * `table sync` — fill the table's columns from the lane records on its issues.
 *
 * Everything is read before anything is written: the project and its rows, the issue graph out to
 * every group the run touches, every lane record on those issues, and whether the pull requests the
 * records name have merged. A record that does not read refuses the whole run, because a sum over it
 * is undecidable.
 *
 * The writes then run in two passes over one plan. Adds land first, the rows are re-read so each new
 * item has an id, and the values follow. **The last plan must be empty**: it is the read-back, and it
 * is also what makes a second run answer `unchanged`.
 *
 * Sync never creates or links a project. With no table found it refuses and names `table setup`.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9856
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type TableSettings, tableKey} from "../config/keys/table.ts";
import {readKey} from "../config/read-key.ts";
import {blockedBy, blocking, subIssues} from "../io/edges.ts";
import type {Api} from "../io/gh-api.ts";
import {type Attempt, fail, ok, type Shell} from "../io/git.ts";
import {
	absent,
	type Existence,
	getIssue,
	issueNodeId,
	listCommentsReconciled,
	present,
	resolveRepo,
	unknown,
} from "../io/issues.ts";
import {
	addItem,
	clearFieldValue,
	type FieldValue,
	type ProjectItem,
	type ProjectSnapshot,
	type ProjectsAnswer,
	readItems,
	readOwnerProjects,
	readProject,
	readProjectByNumber,
	readRepository,
	setFieldValue,
	withProjects,
} from "../io/projects.ts";
import {getPullRequest} from "../io/pulls.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {type LaneRecord, read} from "../wire/lane-record.ts";
import {
	AMBIGUOUS_PROJECT,
	CONFIG_MALFORMED,
	MALFORMED_RECORD,
	NO_TARGET,
	NOT_SET_UP,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	SCOPE_MISSING,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {kindOf, membersOf} from "./group.ts";
import {type BoardTarget, productBoard} from "./shape.ts";
import {
	describeWrite,
	planSync,
	type Row,
	type Scope,
	type SyncNode,
	type SyncPlan,
	scope,
	type TableFields,
	tableFields,
	type Write,
} from "./sync.ts";

const VERB = "table sync";

/** How many issues one run may read into its graph before it stops rather than walk on. */
export const GRAPH_CAP = 2000;

/**
 * How many GitHub reads a table reader keeps in flight at once. GitHub asks REST clients to avoid
 * concurrent requests because of its secondary rate limits
 * ([best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#avoid-concurrent-requests)),
 * so the cap stays small.
 */
export const READ_FAN_OUT = 8;

/** Run `read` over every key, at most {@link READ_FAN_OUT} at once, answering in the keys' order. */
export const readEach = <K, A, R>(
	keys: ReadonlyArray<K>,
	read: (key: K) => Effect.Effect<A, never, R>,
): Effect.Effect<ReadonlyArray<readonly [K, A]>, never, R> =>
	Effect.forEach(keys, (key) => Effect.map(read(key), (value) => [key, value] as const), {
		concurrency: READ_FAN_OUT,
	});

export type Located =
	| {readonly _tag: "Located"; readonly project: ProjectSnapshot}
	| {readonly _tag: "Refused"; readonly code: number; readonly reason: string};

type Target = {readonly projectId: string; readonly itemId: string; readonly fieldId: string};

/** Every board act the verb takes, passed in so the verb stays provable offline. */
export interface SyncBoard<R> {
	readonly locate: (
		repo: string,
		target: BoardTarget,
	) => Effect.Effect<ProjectsAnswer<Located>, never, R>;
	readonly items: (
		projectId: string,
	) => Effect.Effect<ProjectsAnswer<ReadonlyArray<ProjectItem>>, never, R>;
	/** The issue's state and native edges; `Absent` when the number is no issue of this repository. */
	readonly node: (repo: string, issue: number) => Effect.Effect<Existence<SyncNode>, never, R>;
	/** The bodies of every comment on the issue, read whole. */
	readonly comments: (
		repo: string,
		issue: number,
	) => Effect.Effect<Attempt<ReadonlyArray<string>>, never, R>;
	readonly merged: (repo: string, pr: number) => Effect.Effect<Attempt<boolean>, never, R>;
	/** Add the issue as a real issue item — the only add there is, so no draft can be made. */
	readonly add: (
		projectId: string,
		repo: string,
		issue: number,
	) => Effect.Effect<ProjectsAnswer<string>, never, R>;
	readonly set: (
		target: Target,
		value: FieldValue,
	) => Effect.Effect<ProjectsAnswer<string>, never, R>;
	readonly clear: (target: Target) => Effect.Effect<ProjectsAnswer<string>, never, R>;
}

export interface SyncOptions<R> {
	readonly repo: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The issues to sync; empty syncs every issue already on the table. */
	readonly issues: ReadonlyArray<number>;
	readonly board: SyncBoard<R>;
}

export type Refusal = {readonly _tag: "Refused"; readonly code: number; readonly reason: string};

const refused = (code: number, reason: string): Refusal => ({_tag: "Refused", code, reason});

const stop = (
	failed: Exclude<ProjectsAnswer<unknown>, {_tag: "Ok"}>,
	onFailure: number,
	what: string,
): Refusal =>
	failed._tag === "MissingScope"
		? refused(SCOPE_MISSING, `${VERB}: ${failed.reason}.`)
		: refused(onFailure, `${VERB}: ${what}: ${failed.reason}.`);

export const rowsOf = (items: ReadonlyArray<ProjectItem>, repo: string): Map<number, Row> =>
	new Map(
		items.flatMap((item) =>
			item.contentType === "Issue" && item.repository === repo && item.contentNumber !== null
				? [
						[
							item.contentNumber,
							{itemId: item.itemId, issue: item.contentNumber, values: item.values},
						],
					]
				: [],
		),
	);

/** A number the repository has no issue for: no edges, never open, never added. */
const vanished = (issue: number): SyncNode => ({
	number: issue,
	open: false,
	parent: null,
	subIssues: [],
	blockedBy: [],
	blocking: [],
});

interface World {
	readonly _tag: "World";
	readonly scope: Extract<Scope, {_tag: "Scoped"}>;
	readonly graph: ReadonlyMap<number, SyncNode>;
	readonly records: ReadonlyMap<number, ReadonlyArray<LaneRecord>>;
	readonly merged: ReadonlySet<number>;
}

const touched = (world: Pick<World, "scope">): ReadonlyArray<number> =>
	[...new Set([...world.scope.heads.map((group) => group.head), ...world.scope.members])].sort(
		(a, b) => a - b,
	);

/** The board reads every table reader shares: the project, its rows, the graph and the records. */
export type TableBoard<R> = Pick<SyncBoard<R>, "locate" | "items" | "node" | "comments">;

/** The rows a run touches and the graph that decides their groups. */
export interface Scoped {
	readonly _tag: "Graph";
	readonly scope: Extract<Scope, {_tag: "Scoped"}>;
	readonly graph: ReadonlyMap<number, SyncNode>;
}

/**
 * Read the graph out from the seeds until every group the run touches is decidable. `verb` names the
 * reader in its refusals, and every refusal says nothing was written, since none of them writes.
 */
export const readScope = <R>(
	board: TableBoard<R>,
	verb: string,
	repo: string,
	seeds: ReadonlyArray<number>,
	rows: ReadonlySet<number>,
): Effect.Effect<Scoped | Refusal, never, R> =>
	Effect.gen(function* () {
		const graph = new Map<number, SyncNode>();
		let scoped: Scope = scope(seeds, rows, graph);
		let wanted: ReadonlyArray<number> = scoped._tag === "Incomplete" ? scoped.missing : [];
		while (wanted.length > 0) {
			if (graph.size + wanted.length > GRAPH_CAP) {
				return refused(
					PRECONDITION_UNKNOWN,
					`${verb}: the groups this run touches reach past ${GRAPH_CAP} issues — name fewer issues at a time. Nothing was written.`,
				);
			}
			const reads = yield* readEach(wanted, (issue) => board.node(repo, issue));
			for (const [issue, read] of reads) {
				if (read._tag === "Unknown") {
					return refused(
						PRECONDITION_UNKNOWN,
						`${verb}: cannot read #${issue}: ${read.reason}. Nothing was written.`,
					);
				}
				if (read._tag === "Absent") {
					if (seeds.includes(issue)) {
						return refused(
							NO_TARGET,
							`${verb}: ${repo} has no issue #${issue} (a pull request is not a table row). Nothing was written.`,
						);
					}
					graph.set(issue, vanished(issue));
					continue;
				}
				graph.set(issue, read.value);
			}
			scoped = scope(seeds, rows, graph);
			wanted = scoped._tag === "Incomplete" ? scoped.missing.filter((n) => !graph.has(n)) : [];
		}
		if (scoped._tag !== "Scoped") {
			return refused(
				PRECONDITION_UNKNOWN,
				`${verb}: the issue graph did not settle after reading ${graph.size} issues. Nothing was written.`,
			);
		}
		return {_tag: "Graph", scope: scoped, graph};
	});

export interface Records {
	readonly _tag: "Records";
	readonly records: ReadonlyMap<number, ReadonlyArray<LaneRecord>>;
}

/** Every lane record standing on each touched issue that is open or already a row. */
export const readRecords = <R>(
	board: TableBoard<R>,
	verb: string,
	repo: string,
	scoped: Scoped,
	rows: ReadonlySet<number>,
): Effect.Effect<Records | Refusal, never, R> =>
	Effect.gen(function* () {
		const records = new Map<number, ReadonlyArray<LaneRecord>>();
		const standing = touched(scoped).filter(
			(issue) => scoped.graph.get(issue)?.open === true || rows.has(issue),
		);
		const reads = yield* readEach(standing, (issue) => board.comments(repo, issue));
		for (const [issue, comments] of reads) {
			if (comments._tag === "Failure") {
				return refused(
					PRECONDITION_UNKNOWN,
					`${verb}: cannot read #${issue}'s comments: ${comments.reason} — its lane records are UNKNOWN. Nothing was written.`,
				);
			}
			const found: LaneRecord[] = [];
			for (const body of comments.value) {
				const record = read(body);
				if (record._tag === "Malformed") {
					return refused(
						MALFORMED_RECORD,
						`${verb}: #${issue} carries a lane record that does not read: ${record.reason} — its spend and asks are undecidable. Nothing was written.`,
					);
				}
				if (record._tag === "Found") found.push(record.value);
			}
			records.set(issue, found);
		}
		return {_tag: "Records", records};
	});

/** Read the graph, the records, and whether the pull requests the records name have merged. */
const readWorld = <R>(
	board: SyncBoard<R>,
	repo: string,
	seeds: ReadonlyArray<number>,
	rows: ReadonlySet<number>,
): Effect.Effect<World | Refusal, never, R> =>
	Effect.gen(function* () {
		const scoped = yield* readScope(board, VERB, repo, seeds, rows);
		if (scoped._tag === "Refused") return scoped;
		const read = yield* readRecords(board, VERB, repo, scoped, rows);
		if (read._tag === "Refused") return read;
		const {records} = read;

		const merged = new Set<number>();
		const prs = new Set([...records.values()].flat().flatMap((record) => record.prs));
		const reads = yield* readEach(
			[...prs].sort((a, b) => a - b),
			(pr) => board.merged(repo, pr),
		);
		for (const [pr, state] of reads) {
			if (state._tag === "Failure") {
				return refused(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read whether #${pr} merged: ${state.reason}. Nothing was written.`,
				);
			}
			if (state.value) merged.add(pr);
		}
		return {_tag: "World", scope: scoped.scope, graph: scoped.graph, records, merged};
	});

const planOver = (world: World, rows: ReadonlyMap<number, Row>, fields: TableFields): SyncPlan =>
	planSync({...world, rows, fields});

const applyAll = <R>(
	board: SyncBoard<R>,
	project: ProjectSnapshot,
	repo: string,
	writes: ReadonlyArray<Write>,
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
			}
			if (done._tag !== "Ok") {
				const so = landed.length > 0 ? ` after: ${landed.join("; ")}` : "";
				return stop(
					done,
					WRITE_UNKNOWN,
					`${describeWrite(write)} did not land — UNKNOWN${so}; re-run sync to finish`,
				);
			}
			landed.push(describeWrite(write));
		}
		return null;
	});

type Synced = {
	readonly _tag: "Synced";
	readonly project: ProjectSnapshot;
	readonly world: World;
	readonly changes: ReadonlyArray<string>;
	readonly skipped: SyncPlan["skipped"];
};

const converge = <R>(
	board: SyncBoard<R>,
	repo: string,
	settings: TableSettings,
	issues: ReadonlyArray<number>,
): Effect.Effect<Synced | Refusal, never, R> =>
	Effect.gen(function* () {
		const located = yield* board.locate(repo, productBoard(repo, settings));
		if (located._tag !== "Ok") return stop(located, PRECONDITION_UNKNOWN, "cannot find the table");
		if (located.value._tag === "Refused") return located.value;
		const {project} = located.value;
		const resolved = tableFields(project);
		if (resolved._tag === "Missing") {
			return refused(
				NOT_SET_UP,
				`${VERB}: project #${project.number} lacks ${resolved.what.join(", ")} — run \`fabrika table setup\` first. Nothing was written.`,
			);
		}
		const {fields} = resolved;

		const readRows = Effect.map(
			board.items(project.id),
			(items): ProjectsAnswer<ReadonlyMap<number, Row>> =>
				items._tag === "Ok" ? {_tag: "Ok", value: rowsOf(items.value, repo)} : items,
		);
		const opened = yield* readRows;
		if (opened._tag !== "Ok") {
			return stop(opened, PRECONDITION_UNKNOWN, `cannot read project #${project.number}'s rows`);
		}
		const first = opened.value;
		const seeds = issues.length > 0 ? issues : [...first.keys()].sort((a, b) => a - b);
		const world = yield* readWorld(board, repo, seeds, new Set(first.keys()));
		if (world._tag === "Refused") return world;

		const landed: string[] = [];
		const opening = planOver(world, first, fields);
		const adds = opening.writes.filter((write) => write._tag === "Add");
		const addFailed = yield* applyAll(board, project, repo, adds, landed);
		if (addFailed !== null) return addFailed;

		let rows: ReadonlyMap<number, Row> = first;
		if (adds.length > 0) {
			const reread = yield* readRows;
			if (reread._tag !== "Ok") {
				return stop(
					reread,
					READBACK_MISMATCH,
					`wrote ${landed.join("; ")} and could not re-read the rows`,
				);
			}
			rows = reread.value;
		}
		const values = planOver(world, rows, fields).writes;
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
			const final = yield* readRows;
			if (final._tag !== "Ok") {
				return stop(
					final,
					READBACK_MISMATCH,
					`wrote ${landed.join("; ")} and could not re-read the rows`,
				);
			}
			const settled = planOver(world, final.value, fields);
			if (settled.writes.length > 0) {
				return refused(
					READBACK_MISMATCH,
					`${VERB}: wrote ${landed.join("; ")} and the rows still do not read in step: ${settled.writes.map(describeWrite).join("; ")} — re-read the project before retrying.`,
				);
			}
		}
		return {_tag: "Synced", project, world, changes: landed, skipped: opening.skipped};
	});

export const runSync = <R>(
	options: SyncOptions<R>,
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
		const resolved = yield* resolveRepo(options.repo, options.env);
		if (resolved._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: no --repo, no CLAUDE_PIPELINE_REPO, no GITHUB_REPOSITORY and no readable origin remote — no repository to sync the table of.`,
			);
		}
		const repo = resolved.value;
		const run = yield* converge(options.board, repo, settings.value, options.issues);
		if (run._tag === "Refused") return refuse(run.code, run.reason);

		const {project, world, changes, skipped} = run;
		const groups = world.scope.heads
			.filter((group) => group._tag !== "Single")
			.map((group) => ({head: group.head, kind: kindOf(group), members: membersOf(group)}));
		const notes = [
			`${VERB}: read ${settings.note}.`,
			`${VERB}: project #${project.number} "${project.title}" (${project.url}); ${touched(world).length} issue(s) touched.`,
			...groups.map(
				(group) =>
					`${VERB}: #${group.head} is a ${group.kind} row over ${group.members.length === 0 ? "no open member" : group.members.map((n) => `#${n}`).join(", ")}.`,
			),
			...skipped.map((skip) => `${VERB}: skipped #${skip.issue}: ${skip.reason}.`),
			...(changes.length > 0
				? changes.map((change) => `${VERB}: ${change}.`)
				: [`${VERB}: every touched row already reads in step; nothing was written.`]),
		];
		return answer(
			`${JSON.stringify({
				answer: changes.length > 0 ? "synced" : "unchanged",
				repo,
				project: {number: project.number, title: project.title, url: project.url},
				issues: touched(world),
				groups,
				changes,
				skipped,
			})}\n`,
			notes,
		);
	});

/** Find the table without creating or linking anything: configured, else by its title. */
export const locateTable = (
	token: string,
	repo: string,
	target: BoardTarget,
	verb: string,
): Api<ProjectsAnswer<Located>> =>
	Effect.gen(function* () {
		const found = (value: Located): ProjectsAnswer<Located> => ({_tag: "Ok", value});
		const node = yield* readRepository(token, repo);
		if (node._tag !== "Ok") return node;
		const owner = target.project.owner ?? node.value.owner.login;
		if (target.project.number !== null) {
			const read = yield* readProjectByNumber(token, owner, target.project.number);
			if (read._tag !== "Ok") return read;
			return found(
				read.value === null
					? refused(
							NO_TARGET,
							`${verb}: \`${target.key}\` names project ${target.project.number} under ${owner}, and ${owner} has no such project. Nothing was written.`,
						)
					: {_tag: "Located", project: read.value},
			);
		}
		const {title} = target;
		let refs = node.value.linkedProjects.filter((ref) => ref.title === title && !ref.closed);
		if (refs.length === 0) {
			const owned = yield* readOwnerProjects(token, owner);
			if (owned._tag !== "Ok") return owned;
			refs = owned.value.projects.filter((ref) => ref.title === title && !ref.closed);
		}
		const [only, ...more] = refs;
		if (only === undefined) {
			return found(
				refused(
					NO_TARGET,
					`${verb}: no open project titled "${title}" is linked to ${repo} or owned by ${owner} — run \`fabrika table setup\` first. Nothing was written.`,
				),
			);
		}
		if (more.length > 0) {
			return found(
				refused(
					AMBIGUOUS_PROJECT,
					`${verb}: ${refs.length} open projects are titled "${title}" (${refs.map((ref) => `#${ref.number}`).join(", ")}) — set \`${target.key}.number\` in .fabrika.jsonc. Nothing was written.`,
				),
			);
		}
		const read = yield* readProject(token, only.id);
		return read._tag === "Ok" ? found({_tag: "Located", project: read.value}) : read;
	});

/** The shipped board: GitHub, under the ambient token. */
export const syncBoard: SyncBoard<ChildProcessSpawner.ChildProcessSpawner> = {
	locate: (repo, target) => withProjects((token) => locateTable(token, repo, target, VERB)),
	items: (projectId) => withProjects((token) => readItems(token, projectId)),
	node: (repo, issue) =>
		Effect.gen(function* () {
			const found = yield* getIssue(repo, issue);
			if (found._tag !== "Present") return found;
			if (found.value.isPullRequest) return absent<SyncNode>();
			const reads = yield* Effect.all(
				[subIssues, blockedBy, blocking].map((list) => list(repo, issue)),
				{concurrency: "unbounded"},
			);
			const edges: Array<ReadonlyArray<number>> = [];
			for (const read of reads) {
				if (read._tag === "Unknown") return read;
				if (read._tag === "Absent") return unknown<SyncNode>(`#${issue}'s edges vanished mid-read`);
				edges.push(read.value);
			}
			const [children = [], blockers = [], blocked = []] = edges;
			return present<SyncNode>({
				number: issue,
				open: found.value.state === "open",
				parent: found.value.parent._tag === "Parent" ? found.value.parent.number : null,
				subIssues: children,
				blockedBy: blockers,
				blocking: blocked,
			});
		}),
	comments: (repo, issue): Shell<Attempt<ReadonlyArray<string>>> =>
		Effect.map(listCommentsReconciled(repo, issue), (scan) =>
			scan._tag === "Failure" ? scan : ok(scan.value.comments.map((comment) => comment.body)),
		),
	merged: (repo, pr) =>
		Effect.map(getPullRequest(repo, pr), (found): Attempt<boolean> => {
			if (found._tag === "Unknown") return fail(found.reason);
			return ok(found._tag === "Present" && found.value.merged);
		}),
	add: (projectId, repo, issue) =>
		Effect.gen(function* () {
			const content = yield* issueNodeId(repo, issue);
			if (content._tag !== "Present") {
				return {
					_tag: "Failed" as const,
					reason: `cannot read #${issue}'s node id: ${content._tag === "Unknown" ? content.reason : "it is no issue"}`,
				};
			}
			return yield* withProjects((token) => addItem(token, projectId, content.value));
		}),
	set: (target, value) => withProjects((token) => setFieldValue(token, target, value)),
	clear: (target) => withProjects((token) => clearFieldValue(token, target)),
};
