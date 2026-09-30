/**
 * `lane record` — post a terminal lane's record to its issue, once per terminal.
 *
 * The order is the contract. The record is composed offline first, so a lane that has not ended
 * costs no board read. It is then scrubbed of machine-local paths and checked against the leak
 * guard, so nothing reaches a public issue that the guard would refuse. The issue's comments are
 * read next, and a record already standing for this same terminal answers `unchanged` with nothing
 * written — which is what makes the driver's terminal step safe to re-run. A `complete` record then
 * reads the issue itself and refuses while it is open or unread. Only then is the comment posted,
 * and it is read back through the format's own reader before the verb says `posted`.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9855
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {findLeaks} from "../guard/leak.ts";
import type {Attempt} from "../io/git.ts";
import {
	createComment,
	getComment,
	getIssue,
	listCommentsReconciled,
	resolveRepo,
} from "../io/issues.ts";
import {isRecord, parseJson} from "../io/json.ts";
import {scanBody} from "../report/leaks.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	asksOf,
	emit,
	type LaneRecord,
	read,
	type Spent,
	sameTerminal,
} from "../wire/lane-record.ts";
import {type IssueRead, issueStateOf} from "./closing-merge.ts";
import {
	APPEND_UNKNOWN,
	ISSUE_LIVE,
	ISSUE_UNRESOLVED,
	LANE_NOT_TERMINAL,
	LANE_UNREADABLE,
	LEAKED_PATH,
	MALFORMED_RECORD,
	MARKER_READBACK,
} from "./codes.ts";
import {loadFacts} from "./facts.ts";
import type {KeyIssue} from "./key.ts";
import {composeRecord} from "./record.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane record";

/** The terminal state a lane that finished its work folds to (`templates/*.workflow.json`). */
const COMPLETE = "complete";

/** The path the leak guard judges the body as — a doc, so every doc-surface shape applies. */
const LEAK_SURFACE = "lane-record.md";

export interface IssueComment {
	readonly id: number;
	readonly body: string;
}

/** The board acts the verb takes, passed in so the verb stays provable offline. */
export interface RecordBoard<R> {
	/** One read of the issue itself, taken before a `complete` record is posted. */
	readonly issue: (issue: number) => Effect.Effect<IssueRead, never, R>;
	readonly comments: (
		issue: number,
	) => Effect.Effect<Attempt<ReadonlyArray<IssueComment>>, never, R>;
	readonly post: (
		issue: number,
		body: string,
	) => Effect.Effect<Attempt<{readonly id: number; readonly url: string}>, never, R>;
	readonly readBack: (id: number) => Effect.Effect<Attempt<string>, never, R>;
}

export interface RecordOptions<R> extends LaneRef {
	readonly issue: KeyIssue;
	readonly spent: Spent;
	readonly board: RecordBoard<R>;
	/**
	 * `table sync` for the issue, run once its record stands — posted now or already there. Its
	 * refusal never undoes the record: the answer names the exit, and a re-run retries the sync.
	 */
	readonly syncTable?: (
		issue: number,
	) => Effect.Effect<VerbOutcome, never, R | FileSystem.FileSystem | Path.Path>;
}

/** What the table sync after a record answered, for the record's own answer. */
const followTable = <R>(
	options: RecordOptions<R>,
	issue: number,
): Effect.Effect<
	{readonly table: Record<string, unknown> | null; readonly notes: ReadonlyArray<string>},
	never,
	R | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		if (options.syncTable === undefined) return {table: null, notes: []};
		const synced = yield* options.syncTable(issue);
		if (synced.code !== 0) {
			return {
				table: {code: synced.code},
				notes: [
					...synced.stderr,
					`${VERB}: the record stands, and the table did not sync (exit ${synced.code}) — re-run \`fabrika table sync ${issue}\` once the cause above is fixed.`,
				],
			};
		}
		const parsed = parseJson(synced.stdout);
		const verdict = isRecord(parsed) ? (parsed.answer ?? null) : null;
		return {table: {code: 0, answer: verdict}, notes: synced.stderr};
	});

const summary = (record: LaneRecord): Record<string, unknown> => ({
	outcome: record.outcome,
	origin: record.origin,
	asks: asksOf(record),
	builds: record.builds,
	reviews: record.reviews,
	parks: record.parks.length,
	spent: record.spent,
	prs: record.prs,
});

export const runRecord = <R>(
	options: RecordOptions<R>,
): Effect.Effect<VerbOutcome, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const loaded = yield* loadLane(options);
		if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);
		if (options.issue._tag !== "Issue") {
			return refuse(
				ISSUE_UNRESOLVED,
				`${VERB}: lane ${options.lane} drives no issue, so its record has nowhere to land — print its history with \`fabrika lane history ${options.lane}\` instead. Nothing was posted.`,
			);
		}
		const issue = options.issue.number;
		const facts = yield* loadFacts(loaded.dir);
		if (facts._tag === "Unreadable") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read ${facts.path}: ${facts.reason} — the lane's origin and wait are UNKNOWN. Nothing was posted.`,
			);
		}
		if (facts._tag === "Malformed") {
			return refuse(
				MALFORMED_RECORD,
				`${VERB}: ${facts.path} was read in full and is not the shape. Nothing was posted.`,
				facts.defects.map((defect) => `${VERB}: defect: ${defect}`),
			);
		}
		const composed = composeRecord({
			issue,
			lane: loaded.lane,
			entries: loaded.entries,
			facts: facts.facts,
			spent: options.spent,
		});
		if (composed._tag === "Unreplayable") return replayRefusal(VERB, loaded.logPath, composed);
		if (composed._tag === "NotTerminal") {
			return refuse(
				LANE_NOT_TERMINAL,
				`${VERB}: lane ${options.lane} folds to ${JSON.stringify(composed.stateValue)}, which is not a terminal state — a record is posted once the lane ends. Nothing was posted.`,
			);
		}
		const {record} = composed;

		const scan = scanBody(emit(record));
		const body = scan.redacted;
		const leaks = findLeaks(LEAK_SURFACE, body);
		const reread = read(body);
		if (leaks.length > 0 || reread._tag !== "Found" || !sameTerminal(reread.value, record)) {
			return refuse(
				LEAKED_PATH,
				`${VERB}: the record still carries a machine-local path after scrubbing, or scrubbing left it unreadable — it is headed for a public issue, so nothing was posted.`,
				leaks.map((leak) => `${VERB}: leak: ${leak.matched} (${leak.reason})`),
			);
		}
		const notes =
			scan.leaks.length === 0
				? []
				: [
						`${VERB}: scrubbed ${scan.leaks.length} machine-local path(s) from the record before posting.`,
					];

		const listed = yield* options.board.comments(issue);
		if (listed._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read #${issue}'s comments: ${listed.reason} — whether this terminal is already recorded is UNKNOWN. Nothing was posted.`,
			);
		}
		for (const comment of listed.value) {
			const standing = read(comment.body);
			if (standing._tag === "Found" && sameTerminal(standing.value, record)) {
				const followed = yield* followTable(options, issue);
				return answer(
					JSON.stringify({
						answer: "unchanged",
						lane: options.lane,
						issue,
						commentId: comment.id,
						...summary(record),
						...(followed.table === null ? {} : {table: followed.table}),
					}),
					[
						`${VERB}: #${issue} already carries the record of this terminal (comment ${comment.id}) — nothing was written.`,
						...followed.notes,
					],
				);
			}
			if (standing._tag === "Malformed") {
				return refuse(
					MALFORMED_RECORD,
					`${VERB}: #${issue} carries a lane record that does not read (comment ${comment.id}): ${standing.reason} — whether this terminal is already recorded is undecidable. Nothing was posted.`,
				);
			}
		}

		// A `complete` record says the work is done, and a merge-queue merge has left a `Fixes #N`
		// issue open under a lane that folded to `complete` anyway — so the issue is read first.
		if (record.outcome === COMPLETE) {
			const state = issueStateOf(issue, yield* options.board.issue(issue));
			if (state._tag === "Open") {
				return refuse(
					ISSUE_LIVE,
					`${VERB}: lane ${options.lane} folded to ${COMPLETE}, and #${issue} is still open — close #${issue} as completed with a pointer to the merge the lane's terminal line names, then re-run this. Nothing was posted.`,
					notes,
				);
			}
			if (state._tag === "Unread") {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: ${state.reason} — whether #${issue} is closed is UNKNOWN, so no ${COMPLETE} record is posted over it. Nothing was posted.`,
					notes,
				);
			}
		}

		const posted = yield* options.board.post(issue, body);
		if (posted._tag === "Failure") {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: the post to #${issue} failed: ${posted.reason} — it may or may not have landed; re-run, which answers \`unchanged\` if it did.`,
				notes,
			);
		}
		const back = yield* options.board.readBack(posted.value.id);
		const landed = back._tag === "Ok" ? read(back.value) : null;
		if (landed?._tag !== "Found" || !sameTerminal(landed.value, record)) {
			return refuse(
				MARKER_READBACK,
				`${VERB}: posted comment ${posted.value.id} on #${issue}, and it does not read back as this terminal's record — it needs a human eye.`,
				notes,
			);
		}
		const followed = yield* followTable(options, issue);
		return answer(
			JSON.stringify({
				answer: "posted",
				lane: options.lane,
				issue,
				commentId: posted.value.id,
				url: posted.value.url,
				...summary(record),
				...(followed.table === null ? {} : {table: followed.table}),
			}),
			[
				...notes,
				`${VERB}: posted the ${record.outcome} record to #${issue} (comment ${posted.value.id}).`,
				...followed.notes,
			],
		);
	});

/** The shipped board: the target repo's issue comments, read whole before anything is posted. */
export const recordBoard = (
	repo: string | null,
	env: Readonly<Record<string, string | undefined>>,
): RecordBoard<ChildProcessSpawner.ChildProcessSpawner> => {
	const target = resolveRepo(repo, env);
	return {
		issue: (issue) =>
			Effect.gen(function* () {
				const name = yield* target;
				return name._tag === "Failure"
					? {_tag: "Unknown" as const, reason: name.reason}
					: yield* getIssue(name.value, issue);
			}),
		comments: (issue) =>
			Effect.gen(function* () {
				const name = yield* target;
				if (name._tag === "Failure") return name;
				const scan = yield* listCommentsReconciled(name.value, issue);
				return scan._tag === "Failure"
					? scan
					: {_tag: "Ok" as const, value: scan.value.comments.map(({id, body}) => ({id, body}))};
			}),
		post: (issue, body) =>
			Effect.gen(function* () {
				const name = yield* target;
				return name._tag === "Failure" ? name : yield* createComment(name.value, issue, body);
			}),
		readBack: (id) =>
			Effect.gen(function* () {
				const name = yield* target;
				return name._tag === "Failure" ? name : yield* getComment(name.value, id);
			}),
	};
};
