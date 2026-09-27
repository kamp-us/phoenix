/**
 * `lane record` — post a terminal lane's record to its issue, once per terminal.
 *
 * The order is the contract. The record is composed offline first, so a lane that has not ended
 * costs no board read. It is then scrubbed of machine-local paths and checked against the leak
 * guard, so nothing reaches a public issue that the guard would refuse. The issue's comments are
 * read next, and a record already standing for this same terminal answers `unchanged` with nothing
 * written — which is what makes the driver's terminal step safe to re-run. Only then is the comment
 * posted, and it is read back through the format's own reader before the verb says `posted`.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9855
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {findLeaks} from "../guard/leak.ts";
import type {Attempt} from "../io/git.ts";
import {createComment, getComment, listCommentsReconciled, resolveRepo} from "../io/issues.ts";
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
import {
	APPEND_UNKNOWN,
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

/** The path the leak guard judges the body as — a doc, so every doc-surface shape applies. */
const LEAK_SURFACE = "lane-record.md";

export interface IssueComment {
	readonly id: number;
	readonly body: string;
}

/** The three board acts the verb takes, passed in so the verb stays provable offline. */
export interface RecordBoard<R> {
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
}

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
				return answer(
					JSON.stringify({
						answer: "unchanged",
						lane: options.lane,
						issue,
						commentId: comment.id,
						...summary(record),
					}),
					[
						`${VERB}: #${issue} already carries the record of this terminal (comment ${comment.id}) — nothing was written.`,
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
		return answer(
			JSON.stringify({
				answer: "posted",
				lane: options.lane,
				issue,
				commentId: posted.value.id,
				url: posted.value.url,
				...summary(record),
			}),
			[
				...notes,
				`${VERB}: posted the ${record.outcome} record to #${issue} (comment ${posted.value.id}).`,
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
